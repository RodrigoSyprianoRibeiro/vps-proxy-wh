/**
 * Betfair Exchange API - Modulo de autenticacao e busca de odds
 *
 * Suporta dois metodos de login:
 * 1. Login interativo (padrao): username + password + API key (sem certificado)
 * 2. Login com certificado SSL: se BETFAIR_CERT_PATH estiver configurado
 *
 * Busca mercados e odds para eventos de futebol
 * Cache em memoria para sessao e market IDs
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// Configuracao via .env
const BETFAIR_APP_KEY = process.env.BETFAIR_APP_KEY || '';
const BETFAIR_USERNAME = process.env.BETFAIR_USERNAME || '';
const BETFAIR_PASSWORD = process.env.BETFAIR_PASSWORD || '';
const BETFAIR_CERT_PATH = process.env.BETFAIR_CERT_PATH || '';
const BETFAIR_KEY_PATH = process.env.BETFAIR_KEY_PATH || '';

// URLs da API Betfair
const LOGIN_URL_INTERACTIVE = 'https://identitysso.betfair.com/api/login';
const LOGIN_URL_CERT = 'https://identitysso-cert.betfair.com/api/certlogin';
const API_URL = 'https://api.betfair.com/exchange/betting/json-rpc/v1';

// Detecta se tem certificado configurado
function temCertificado() {
    if (!BETFAIR_CERT_PATH || !BETFAIR_KEY_PATH) return false;
    const certPath = path.resolve(BETFAIR_CERT_PATH);
    const keyPath = path.resolve(BETFAIR_KEY_PATH);
    return fs.existsSync(certPath) && fs.existsSync(keyPath);
}

// Cache em memoria
let sessionToken = null;
let sessionExpiry = 0;
const marketCache = new Map(); // eventId -> { markets, expiry }
const oddsCache = new Map();   // eventId -> { odds, expiry }

// TTLs
const SESSION_TTL = 4 * 60 * 60 * 1000;  // 4 horas
const MARKET_CACHE_TTL = 2 * 60 * 60 * 1000; // 2 horas
const ODDS_CACHE_TTL = 10 * 60 * 1000; // 10 minutos

// Mercados que queremos buscar
const MARKET_TYPES = [
    'MATCH_ODDS',
    'OVER_UNDER_05',
    'OVER_UNDER_15',
    'OVER_UNDER_25',
    'BOTH_TEAMS_TO_SCORE',
    'FIRST_HALF_GOALS_05',
    'FIRST_HALF_GOALS_15',
];

// Mapeamento de mercados Betfair -> colunas do BD
const MARKET_MAP = {
    'MATCH_ODDS': {
        'Home': 'odd_ft_1',
        'Draw': 'odd_ft_x',
        'Away': 'odd_ft_2',
        // Alternativas de nome dos runners
        'The Draw': 'odd_ft_x',
    },
    'OVER_UNDER_05': {
        'Over 0.5 Goals': 'odd_over05FT',
        'Under 0.5 Goals': 'odd_under05FT',
    },
    'OVER_UNDER_15': {
        'Over 1.5 Goals': 'odd_over15FT',
        'Under 1.5 Goals': 'odd_under15FT',
    },
    'OVER_UNDER_25': {
        'Over 2.5 Goals': 'odd_over25FT',
        'Under 2.5 Goals': 'odd_under25FT',
    },
    'BOTH_TEAMS_TO_SCORE': {
        'Yes': 'odd_btts_yes',
        'No': 'odd_btts_no',
    },
    'FIRST_HALF_GOALS_05': {
        'Over 0.5 Goals': 'odd_over05HT',
        'Under 0.5 Goals': 'odd_under05HT',
    },
    'FIRST_HALF_GOALS_15': {
        'Over 1.5 Goals': 'odd_over15HT',
        'Under 1.5 Goals': 'odd_under15HT',
    },
};

/**
 * Faz request HTTP com Promise
 */
function httpRequest(url, options, postData) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, options, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                resolve({ statusCode: res.statusCode, body });
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => {
            req.destroy(new Error('Request timeout'));
        });
        if (postData) req.write(postData);
        req.end();
    });
}

/**
 * Login interativo (sem certificado)
 * POST https://identitysso.betfair.com/api/login
 */
async function loginInterativo() {
    const postData = `username=${encodeURIComponent(BETFAIR_USERNAME)}&password=${encodeURIComponent(BETFAIR_PASSWORD)}`;
    const urlObj = new URL(LOGIN_URL_INTERACTIVE);

    const response = await httpRequest(LOGIN_URL_INTERACTIVE, {
        hostname: urlObj.hostname,
        path: urlObj.pathname,
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Application': BETFAIR_APP_KEY,
            'Accept': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
        },
    }, postData);

    const data = JSON.parse(response.body);

    // Login interativo retorna { token, status, error }
    if (data.status !== 'SUCCESS' || !data.token) {
        throw new Error(`Login interativo falhou: ${data.status || 'desconhecido'} - ${data.error || 'sem detalhes'}`);
    }

    return data.token;
}

/**
 * Login com certificado SSL (nao-interativo)
 * POST https://identitysso-cert.betfair.com/api/certlogin
 */
async function loginCertificado() {
    const certPath = path.resolve(BETFAIR_CERT_PATH);
    const keyPath = path.resolve(BETFAIR_KEY_PATH);
    const cert = fs.readFileSync(certPath);
    const key = fs.readFileSync(keyPath);

    const postData = `username=${encodeURIComponent(BETFAIR_USERNAME)}&password=${encodeURIComponent(BETFAIR_PASSWORD)}`;
    const urlObj = new URL(LOGIN_URL_CERT);

    const response = await httpRequest(LOGIN_URL_CERT, {
        hostname: urlObj.hostname,
        path: urlObj.pathname,
        method: 'POST',
        cert,
        key,
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Application': BETFAIR_APP_KEY,
            'Content-Length': Buffer.byteLength(postData),
        },
    }, postData);

    const data = JSON.parse(response.body);

    // Login com certificado retorna { sessionToken, loginStatus }
    if (data.loginStatus !== 'SUCCESS' || !data.sessionToken) {
        throw new Error(`Login certificado falhou: ${data.loginStatus || data.error || 'desconhecido'}`);
    }

    return data.sessionToken;
}

/**
 * Login na Betfair - usa certificado se disponivel, senao login interativo
 * Retorna session token (cacheado por 4h)
 */
async function login() {
    const agora = Date.now();

    // Retorna cache se valido
    if (sessionToken && agora < sessionExpiry) {
        return sessionToken;
    }

    if (!BETFAIR_APP_KEY || !BETFAIR_USERNAME || !BETFAIR_PASSWORD) {
        throw new Error('Credenciais Betfair nao configuradas no .env');
    }

    let token;
    if (temCertificado()) {
        console.log('[BETFAIR] Autenticando com certificado SSL...');
        token = await loginCertificado();
    } else {
        console.log('[BETFAIR] Autenticando com login interativo (sem certificado)...');
        token = await loginInterativo();
    }

    sessionToken = token;
    sessionExpiry = agora + SESSION_TTL;

    console.log('[BETFAIR] Login OK - sessao renovada');
    return sessionToken;
}

/**
 * Chama a API Betfair Exchange (JSON-RPC)
 */
async function betfairApiCall(method, params) {
    const token = await login();

    const body = JSON.stringify({
        jsonrpc: '2.0',
        method: `SportsAPING/v1.0/${method}`,
        params,
        id: 1,
    });

    const urlObj = new URL(API_URL);

    const response = await httpRequest(API_URL, {
        hostname: urlObj.hostname,
        path: urlObj.pathname,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Application': BETFAIR_APP_KEY,
            'X-Authentication': token,
            'Accept': 'application/json',
            'Content-Length': Buffer.byteLength(body),
        },
    }, body);

    const data = JSON.parse(response.body);

    if (data.error) {
        // Se erro de sessao expirada, limpar cache e tentar novamente
        if (data.error.data && data.error.data.APINGException &&
            data.error.data.APINGException.errorCode === 'INVALID_SESSION_INFORMATION') {
            console.log('[BETFAIR] Sessao expirada, renovando...');
            sessionToken = null;
            sessionExpiry = 0;
            return betfairApiCall(method, params);
        }
        throw new Error(`API Betfair erro: ${JSON.stringify(data.error)}`);
    }

    return data.result;
}

/**
 * Busca mercados de um evento (listMarketCatalogue)
 * Retorna array de { marketId, marketType, runners: [{ selectionId, runnerName }] }
 */
async function getMarketsForEvent(eventId) {
    const agora = Date.now();
    const cached = marketCache.get(eventId);
    if (cached && agora < cached.expiry) {
        return cached.markets;
    }

    const result = await betfairApiCall('listMarketCatalogue', {
        filter: {
            eventIds: [String(eventId)],
            marketTypeCodes: MARKET_TYPES,
        },
        maxResults: 20,
        marketProjection: ['RUNNER_DESCRIPTION', 'RUNNER_METADATA', 'MARKET_DESCRIPTION'],
    });

    const markets = (result || []).map(m => ({
        marketId: m.marketId,
        marketType: m.description?.marketType || m.marketName,
        runners: (m.runners || []).map(r => ({
            selectionId: r.selectionId,
            runnerName: r.runnerName,
            sortPriority: r.sortPriority,
        })),
    }));

    marketCache.set(eventId, { markets, expiry: agora + MARKET_CACHE_TTL });
    return markets;
}

/**
 * Busca odds de mercados (listMarketBook)
 * Retorna map de marketId -> runners com odds
 */
async function getMarketBookPrices(marketIds) {
    if (!marketIds.length) return {};

    const result = await betfairApiCall('listMarketBook', {
        marketIds,
        priceProjection: { priceData: ['EX_BEST_OFFERS'] },
    });

    const bookMap = {};
    for (const book of (result || [])) {
        bookMap[book.marketId] = (book.runners || []).map(r => ({
            selectionId: r.selectionId,
            status: r.status,
            backPrice: r.ex?.availableToBack?.[0]?.price || null,
            backSize: r.ex?.availableToBack?.[0]?.size || null,
            layPrice: r.ex?.availableToLay?.[0]?.price || null,
            laySize: r.ex?.availableToLay?.[0]?.size || null,
        }));
    }

    return bookMap;
}

/**
 * Identifica o runner no MATCH_ODDS (Home, Draw, Away) pelo sortPriority
 * Betfair ordena: 1=Home, 2=Away, 3=Draw
 */
function identificarRunnerMatchOdds(runner, marketType) {
    if (marketType !== 'MATCH_ODDS') {
        return runner.runnerName;
    }

    switch (runner.sortPriority) {
        case 1: return 'Home';
        case 2: return 'Away';
        case 3: return 'Draw';
        default: return runner.runnerName;
    }
}

/**
 * Busca odds completas de um evento
 * Retorna objeto com campos do BD (odd_ft_1, odd_ft_x, etc.)
 */
async function getOddsForEvent(eventId) {
    const agora = Date.now();
    const cached = oddsCache.get(eventId);
    if (cached && agora < cached.expiry) {
        return cached.odds;
    }

    // Passo 1: Buscar mercados do evento
    const markets = await getMarketsForEvent(eventId);

    if (!markets.length) {
        return null;
    }

    // Passo 2: Buscar odds de todos os mercados
    const marketIds = markets.map(m => m.marketId);
    const bookMap = await getMarketBookPrices(marketIds);

    // Passo 3: Parsear odds para formato do BD
    const odds = {};

    for (const market of markets) {
        const marketType = market.marketType;
        const mapping = MARKET_MAP[marketType];
        if (!mapping) continue;

        const book = bookMap[market.marketId];
        if (!book) continue;

        for (const runner of market.runners) {
            const bookRunner = book.find(b => b.selectionId === runner.selectionId);
            if (!bookRunner || !bookRunner.backPrice) continue;

            // Para MATCH_ODDS, usar sortPriority para identificar Home/Draw/Away
            const runnerLabel = identificarRunnerMatchOdds(runner, marketType);
            const campo = mapping[runnerLabel];

            if (campo) {
                odds[campo] = bookRunner.backPrice;
            }
        }
    }

    if (Object.keys(odds).length === 0) {
        return null;
    }

    oddsCache.set(eventId, { odds, expiry: agora + ODDS_CACHE_TTL });
    return odds;
}

/**
 * Handler: GET /betfair-api/odds/:eventId
 */
async function handleGetOdds(req, res) {
    try {
        const eventId = req.params.eventId;
        if (!eventId || !/^\d+$/.test(eventId)) {
            return res.status(400).json({ error: 'eventId invalido' });
        }

        const odds = await getOddsForEvent(eventId);

        if (!odds) {
            return res.status(404).json({ error: 'Sem odds para evento', eventId });
        }

        res.json({ eventId, odds });
    } catch (e) {
        console.error(`[BETFAIR] Erro odds/${req.params.eventId}:`, e.message);
        res.status(500).json({ error: e.message });
    }
}

/**
 * Handler: GET /betfair-api/odds-batch?ids=123,456,789
 * Busca odds de ate 10 eventos em paralelo
 */
async function handleGetOddsBatch(req, res) {
    try {
        const idsParam = req.query.ids || '';
        const ids = idsParam.split(',').filter(id => /^\d+$/.test(id.trim())).map(id => id.trim());

        if (!ids.length) {
            return res.status(400).json({ error: 'Parametro ids obrigatorio (ex: ids=123,456)' });
        }

        if (ids.length > 10) {
            return res.status(400).json({ error: 'Maximo 10 eventos por batch' });
        }

        // Buscar odds em paralelo
        const resultados = {};
        const promises = ids.map(async (eventId) => {
            try {
                const odds = await getOddsForEvent(eventId);
                if (odds) {
                    resultados[eventId] = odds;
                }
            } catch (e) {
                console.error(`[BETFAIR] Erro batch evento ${eventId}:`, e.message);
            }
        });

        await Promise.all(promises);

        res.json({
            total: Object.keys(resultados).length,
            solicitados: ids.length,
            odds: resultados,
        });
    } catch (e) {
        console.error('[BETFAIR] Erro odds-batch:', e.message);
        res.status(500).json({ error: e.message });
    }
}

// Cache de eventos do dia
const eventsCache = { data: null, expiry: 0 };
const eventsCacheLive = { data: null, expiry: 0 };
const EVENTS_CACHE_TTL = 30 * 60 * 1000; // 30 minutos
const EVENTS_CACHE_LIVE_TTL = 5 * 60 * 1000; // 5 minutos

/**
 * Busca todos os eventos de futebol do dia/proximo dia na Betfair
 * Retorna array de { id, name, homeName, awayName, competitionName, startTime, countryCode }
 * @param {number} horasAdiante - Horas a frente (ignorado se live=true)
 * @param {boolean} live - Se true, busca apenas jogos ao vivo (inPlayOnly)
 */
async function listSoccerEvents(horasAdiante = 24, live = false) {
    const agora = Date.now();
    const cache = live ? eventsCacheLive : eventsCache;

    if (cache.data && agora < cache.expiry) {
        return cache.data;
    }

    const filter = { eventTypeIds: ['1'] }; // Futebol

    if (live) {
        filter.inPlayOnly = true;
    } else {
        const from = new Date();
        const to = new Date(agora + horasAdiante * 60 * 60 * 1000);
        filter.marketStartTime = {
            from: from.toISOString(),
            to: to.toISOString(),
        };
    }

    const result = await betfairApiCall('listEvents', { filter });

    // Detectar sessao zumbi: API retorna 0 eventos sem erro (sessao invalida silenciosamente)
    // Forcar re-login e tentar novamente uma vez
    if ((!result || result.length === 0) && !live && sessionToken) {
        console.log('[BETFAIR] listEvents retornou 0 eventos - forcando re-login...');
        sessionToken = null;
        sessionExpiry = 0;
        const retryResult = await betfairApiCall('listEvents', { filter });
        if (retryResult && retryResult.length > 0) {
            console.log(`[BETFAIR] Re-login resolveu: ${retryResult.length} eventos brutos`);
            return parseEventos(retryResult, live);
        }
    }

    return parseEventos(result, live);
}

function parseEventos(result, live) {
    const agora = Date.now();
    const cache = live ? eventsCacheLive : eventsCache;

    const eventos = (result || []).map(item => {
        const ev = item.event || {};
        const nome = ev.name || '';

        // Parsear "Team A v Team B" ou "Team A vs Team B"
        let homeName = '';
        let awayName = '';
        const separadores = [' v ', ' vs '];
        for (const sep of separadores) {
            const idx = nome.indexOf(sep);
            if (idx > -1) {
                homeName = nome.substring(0, idx).trim();
                awayName = nome.substring(idx + sep.length).trim();
                break;
            }
        }

        return {
            id: ev.id,
            name: nome,
            homeName,
            awayName,
            countryCode: ev.countryCode || '',
            startTime: ev.openDate || '',
            marketCount: item.marketCount || 0,
        };
    }).filter(e => e.homeName && e.awayName); // Filtrar apenas jogos com 2 times

    const ttl = live ? EVENTS_CACHE_LIVE_TTL : EVENTS_CACHE_TTL;
    cache.data = eventos;
    cache.expiry = agora + ttl;

    console.log(`[BETFAIR] listEvents${live ? ' (LIVE)' : ''}: ${eventos.length} jogos de futebol`);
    return eventos;
}

/**
 * Handler: GET /betfair-api/events?horas=24&live=true&fresh=true
 * Lista todos os eventos de futebol proximos ou ao vivo
 * fresh=true forca nova sessao e limpa cache de eventos
 */
async function handleListEvents(req, res) {
    try {
        const live = req.query.live === 'true';
        const horas = parseInt(req.query.horas) || 24;
        const fresh = req.query.fresh === 'true';

        if (fresh) {
            console.log('[BETFAIR] fresh=true: forcando nova sessao e limpando cache');
            sessionToken = null;
            sessionExpiry = 0;
            eventsCache.data = null;
            eventsCache.expiry = 0;
            eventsCacheLive.data = null;
            eventsCacheLive.expiry = 0;
        }

        const eventos = await listSoccerEvents(Math.min(horas, 48), live);

        res.json({
            total: eventos.length,
            eventos,
        });
    } catch (e) {
        console.error('[BETFAIR] Erro listEvents:', e.message);
        res.status(500).json({ error: e.message });
    }
}

/**
 * Handler: GET /betfair-api/status
 * Status da conexao com Betfair
 */
async function handleStatus(req, res) {
    res.json({
        configurado: !!(BETFAIR_APP_KEY && BETFAIR_USERNAME && BETFAIR_PASSWORD),
        metodoLogin: temCertificado() ? 'certificado' : 'interativo',
        sessaoAtiva: !!(sessionToken && Date.now() < sessionExpiry),
        sessaoExpira: sessionExpiry ? new Date(sessionExpiry).toISOString() : null,
        cacheMarkets: marketCache.size,
        cacheOdds: oddsCache.size,
    });
}

// Limpar caches expirados a cada 30 minutos
setInterval(() => {
    const agora = Date.now();
    let limpezaMarkets = 0;
    let limpezaOdds = 0;

    for (const [key, val] of marketCache) {
        if (agora > val.expiry) {
            marketCache.delete(key);
            limpezaMarkets++;
        }
    }
    for (const [key, val] of oddsCache) {
        if (agora > val.expiry) {
            oddsCache.delete(key);
            limpezaOdds++;
        }
    }

    if (limpezaMarkets || limpezaOdds) {
        console.log(`[BETFAIR] Cache limpo: ${limpezaMarkets} markets, ${limpezaOdds} odds`);
    }
}, 30 * 60 * 1000);

module.exports = {
    getOdds: handleGetOdds,
    getOddsBatch: handleGetOddsBatch,
    listEvents: handleListEvents,
    getStatus: handleStatus,
};
