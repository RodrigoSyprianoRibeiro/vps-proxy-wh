# VPS Proxy - William Hill Radar

Proxy Node.js hospedado em VPS na DigitalOcean (Londres) para acessar o radar da William Hill sem bloqueio geografico.

## Rotas Disponiveis

| Rota | Destino | Descricao |
|------|---------|-----------|
| `/health` | - | Health check do servidor |
| `/stats` | - | Estatisticas de uso |
| `/wh-api/*` | sports.williamhill.com | Proxy para API/site da William Hill |
| `/diffusion` | WebSocket | Proxy WebSocket para scores em tempo real |
| `/*` | sports.whcdn.net | Proxy para CDN (scoreboard/radar) |

## Informacoes da VPS

| Campo | Valor |
|-------|-------|
| **Provedor** | DigitalOcean |
| **Regiao** | Londres (LON1) |
| **IP** | 209.97.176.182 |
| **Dominio** | radarfutebol.xyz |
| **SSL** | Let's Encrypt (auto-renovacao) |
| **Porta Proxy** | 3000 (interno) |
| **Porta Publica** | 443 (HTTPS via Nginx) |

## IPs/Dominios Permitidos (frame-ancestors)

Configurado no `nginx.conf` via Content-Security-Policy:

| IP/Dominio | Descricao |
|------------|-----------|
| `https://radarfutebol.com` | Site principal |
| `https://www.radarfutebol.com` | Site principal (www) |
| `http://186.233.226.101` | Servidor Node.js SaveInCloud |
| `https://186.233.226.101` | Servidor Node.js SaveInCloud (HTTPS) |

Para adicionar novos IPs, editar `nginx.conf` e atualizar a linha `Content-Security-Policy`.

## IPs Bloqueados

IPs bloqueados por abuso (scrapers, proxies nao autorizados, bots). Configurado em `/etc/nginx/sites-available/radarfutebol.xyz`.

| IP | Data Bloqueio | Motivo |
|----|---------------|--------|
| `18.171.141.153` | 2026-01-25 | AWS EC2 Londres - Proxy/scraper nao autorizado (46k req/dia) |

### Como bloquear um IP

1. Editar o arquivo de configuracao:
```bash
ssh root@209.97.176.182 "nano /etc/nginx/sites-available/radarfutebol.xyz"
```

2. Adicionar linha `deny IP;` na secao de IPs bloqueados:
```nginx
# IPs bloqueados (scrapers/proxies nao autorizados)
deny 18.171.141.153;
deny NOVO.IP.AQUI;
```

3. Testar e recarregar nginx:
```bash
ssh root@209.97.176.182 "nginx -t && systemctl reload nginx"
```

## Verificacao Periodica de Seguranca

**Recomendacao:** Fazer essa verificacao semanalmente ou quando notar lentidao/consumo elevado.

### 1. Verificar IPs com mais conexoes

```bash
ssh root@209.97.176.182 "ss -tn state established | grep ':443' | awk '{print \$4}' | sed 's/:.*//g' | sort | uniq -c | sort -rn | head -20"
```

**Como interpretar:**
- **1-10 conexoes**: Usuario normal (pode ter varias abas/jogos abertos)
- **10-30 conexoes**: Usuario heavy ou internet instavel (reconexoes) - geralmente OK
- **30-100 conexoes**: Suspeito - investigar se e datacenter
- **100+ conexoes**: Muito suspeito - provavelmente proxy/scraper

**Excecoes legitimas:**
- `186.233.226.101` (SaveInCloud) - pode ter muitas conexoes
- IPs residenciais brasileiros com 10-30 conexoes - usuarios assistindo varios jogos

**Sinais de alerta:**
- IPs de datacenters (AWS, Google Cloud, Azure, OVH, Hetzner, DigitalOcean)
- IP com centenas/milhares de conexoes

### 2. Verificar IPs por volume de requisicoes

```bash
ssh root@209.97.176.182 "tail -5000 /var/log/nginx/access.log | awk '{print \$1}' | sort | uniq -c | sort -rn | head -20"
```

**Como interpretar (em 5000 requisicoes do log):**
- **10-100 req**: Usuario normal assistindo alguns jogos
- **100-500 req**: Usuario heavy com varios jogos abertos - geralmente OK
- **500-2000 req**: Suspeito - verificar se e datacenter
- **2000+ req**: Muito suspeito - provavelmente bot/scraper

**Nota:** Usuarios podem abrir 5-10 jogos simultaneamente, cada um gerando varias requisicoes (JS, CSS, imagens, WebSocket). Isso e normal.

### 3. Verificar referers externos (sites usando o radar sem autorizacao)

```bash
ssh root@209.97.176.182 "tail -5000 /var/log/nginx/access.log | awk -F'\"' '{print \$4}' | grep -v 'radarfutebol' | grep -v '^-$' | sort | uniq -c | sort -rn"
```

Se aparecer algum dominio externo, significa que outro site esta embedando o radar.

### 4. Verificar acessos sem referer (possivel scraping)

```bash
ssh root@209.97.176.182 "tail -5000 /var/log/nginx/access.log | grep 'index.html' | grep '\"-\" \"' | awk '{print \$1}' | sort | uniq -c | sort -rn | head -10"
```

### 5. Investigar IP suspeito

```bash
# Substituir IP_SUSPEITO pelo IP a investigar
IP_SUSPEITO="1.2.3.4"

# Ver total de requisicoes do IP
ssh root@209.97.176.182 "grep '$IP_SUSPEITO' /var/log/nginx/access.log | wc -l"

# Ver user-agents usados (varios user-agents = bot/proxy)
ssh root@209.97.176.182 "grep '$IP_SUSPEITO' /var/log/nginx/access.log | awk -F'\"' '{print \$6}' | sort | uniq -c | sort -rn"

# Consultar informacoes do IP
curl -s "https://ipinfo.io/$IP_SUSPEITO"
```

**Indicadores de proxy/scraper (verificar TODOS antes de bloquear):**
- IP pertence a datacenter (AWS, Google, Azure, OVH, Hetzner, DigitalOcean)
- Muitos user-agents diferentes do mesmo IP (usuarios reais tem 1-2 user-agents)
- User-agent vazio ou "-" em grande volume
- Volume absurdo de requisicoes (10.000+ por dia)
- Requisicoes sem referer em grande quantidade

**NAO bloquear apenas por:**
- Muitas conexoes (usuario pode ter varios jogos abertos)
- IP brasileiro/portugues residencial com uso alto (pode ser usuario heavy)
- Algumas requisicoes sem referer (pode ser acesso direto ocasional)

### 6. Comando rapido de auditoria completa

```bash
ssh root@209.97.176.182 "echo '=== TOP IPs CONECTADOS ===' && ss -tn state established | grep ':443' | awk '{print \$4}' | sed 's/:.*//g' | sort | uniq -c | sort -rn | head -10 && echo && echo '=== TOP IPs POR REQUISICOES (ultimas 5000) ===' && tail -5000 /var/log/nginx/access.log | awk '{print \$1}' | sort | uniq -c | sort -rn | head -10 && echo && echo '=== REFERERS EXTERNOS ===' && tail -5000 /var/log/nginx/access.log | awk -F'\"' '{print \$4}' | grep -v 'radarfutebol' | grep -v '^-$' | sort | uniq -c | sort -rn | head -5"
```

## Arquivos

- `server.js` - Servidor Node.js com proxy e WebSocket
- `nginx.conf` - Configuracao do Nginx (reverse proxy + SSL)
- `package.json` - Dependencias do Node.js

## Acesso SSH

```bash
ssh root@209.97.176.182
```

## Localizacao dos arquivos na VPS

```
/var/www/radar-proxy/
├── server.js
├── package.json
└── node_modules/

/etc/nginx/sites-available/radarfutebol.xyz
```

## Comandos Uteis

### PM2 (Gerenciador de Processos)

```bash
# Ver status
pm2 status

# Reiniciar proxy
pm2 restart radar-proxy

# Ver logs
pm2 logs radar-proxy

# Ver logs em tempo real
pm2 logs radar-proxy --lines 50
```

### Nginx

```bash
# Testar configuracao
nginx -t

# Recarregar configuracao
systemctl reload nginx

# Ver status
systemctl status nginx
```

### SSL (Let's Encrypt)

```bash
# Renovar certificado manualmente
certbot renew

# Ver certificados
certbot certificates
```

## Deploy de Atualizacoes

1. Editar `server.js` localmente
2. Copiar para a VPS:
```bash
scp vps-proxy/server.js root@209.97.176.182:/var/www/radar-proxy/
```
3. Reiniciar o proxy:
```bash
ssh root@209.97.176.182 "pm2 restart radar-proxy"
```

## Como Funciona

1. Usuario acessa `https://radarfutebol.xyz/scoreboards/app/football/index.html?eventId=XXX`
2. Nginx recebe a requisicao HTTPS e encaminha para Node.js na porta 3000
3. Node.js faz proxy para `https://sports.whcdn.net` com headers apropriados
4. URLs no HTML/JS/CSS sao reescritas de `sports.whcdn.net` para `radarfutebol.xyz`
5. WebSocket `/diffusion` e proxiado para `wss://scoreboards-push.williamhill.com`

## Troubleshooting

### Proxy nao responde
```bash
ssh root@209.97.176.182 "pm2 status && pm2 logs radar-proxy --lines 20"
```

### Erro de SSL
```bash
ssh root@209.97.176.182 "certbot renew --dry-run"
```

### WebSocket nao conecta
- Verificar se o path `/diffusion` esta sendo proxiado corretamente
- Verificar logs: `pm2 logs radar-proxy | grep -i ws`

## Monitoramento de Recursos

O servidor possui um script de monitoramento que roda a cada 5 minutos via cron.

### Arquivos de Monitoramento

| Arquivo | Descricao |
|---------|-----------|
| `/var/www/radar-proxy/monitor.sh` | Script de coleta de metricas |
| `/var/log/radar-monitor.log` | Log com historico de metricas (7 dias) |

### Cron Configurado

```bash
*/5 * * * * /var/www/radar-proxy/monitor.sh
```

### Formato do Log

```
timestamp|mem_used_mb|mem_percent|swap_used_mb|swap_percent|cpu_load|pm2_mem_mb|total_conns|http_conns|pm2_restarts
```

| Campo | Descricao |
|-------|-----------|
| `timestamp` | Data/hora da coleta |
| `mem_used_mb` | Memoria RAM usada (MB) |
| `mem_percent` | Porcentagem de RAM usada |
| `swap_used_mb` | Swap usado (MB) |
| `swap_percent` | Porcentagem de swap usada |
| `cpu_load` | Load average (1 min) |
| `pm2_mem_mb` | Memoria do processo PM2 (MB) |
| `total_conns` | Total de conexoes TCP |
| `http_conns` | Conexoes HTTP/HTTPS ativas |
| `pm2_restarts` | Numero de restarts do PM2 |

### Comandos de Monitoramento

```bash
# Ver ultimas metricas
ssh root@209.97.176.182 "tail -20 /var/log/radar-monitor.log"

# Ver consumo atual em tempo real
ssh root@209.97.176.182 "pm2 status && free -h && cat /proc/loadavg"

# Ver metricas do PM2
ssh root@209.97.176.182 "pm2 monit"

# Ver conexoes ativas
ssh root@209.97.176.182 "ss -tn | grep ':443\|:3000' | wc -l"

# Ver IPs conectados
ssh root@209.97.176.182 "tail -500 /var/log/nginx/access.log | awk '{print \$1}' | sort | uniq -c | sort -rn"

# Ver origens WebSocket
ssh root@209.97.176.182 "tail -500 /var/log/nginx/access.log | grep '/diffusion' | awk '{print \$1}' | sort | uniq -c | sort -rn"
```

### Limites Recomendados

| Metrica | Normal | Alerta | Critico |
|---------|--------|--------|---------|
| RAM (%) | < 70% | 70-85% | > 85% |
| Swap (%) | < 10% | 10-30% | > 30% |
| CPU Load | < 1.0 | 1.0-2.0 | > 2.0 |
| PM2 Mem | < 150MB | 150-200MB | > 200MB |
| PM2 Restarts | 0 | 1-3 | > 3 |

### Script monitor.sh

```bash
#!/bin/bash

# Monitor de recursos do radar-proxy
# Executa a cada 5 minutos via cron

LOG_FILE="/var/log/radar-monitor.log"
DATE=$(date "+%Y-%m-%d %H:%M:%S")

# Coleta metricas
MEM_TOTAL=$(free -m | awk '/Mem:/ {print $2}')
MEM_USED=$(free -m | awk '/Mem:/ {print $3}')
MEM_PERCENT=$((MEM_USED * 100 / MEM_TOTAL))

SWAP_TOTAL=$(free -m | awk '/Swap:/ {print $2}')
SWAP_USED=$(free -m | awk '/Swap:/ {print $3}')
SWAP_PERCENT=0
[ $SWAP_TOTAL -gt 0 ] && SWAP_PERCENT=$((SWAP_USED * 100 / SWAP_TOTAL))

CPU_LOAD=$(cat /proc/loadavg | awk '{print $1}')

PM2_MEM=$(pm2 jlist 2>/dev/null | grep -o '"memory":[0-9]*' | head -1 | grep -o '[0-9]*')
PM2_MEM_MB=$((PM2_MEM / 1024 / 1024))

CONNECTIONS=$(ss -s | grep "^TCP:" | awk '{print $2}')
HTTP_CONNS=$(ss -tn | grep -c ":3000\|:443")

PM2_RESTARTS=$(pm2 jlist 2>/dev/null | grep -o '"restart_time":[0-9]*' | head -1 | grep -o '[0-9]*')

# Grava no log
echo "$DATE|$MEM_USED|$MEM_PERCENT|$SWAP_USED|$SWAP_PERCENT|$CPU_LOAD|$PM2_MEM_MB|$CONNECTIONS|$HTTP_CONNS|$PM2_RESTARTS" >> "$LOG_FILE"

# Mantem apenas ultimos 7 dias (2016 linhas = 7 dias * 24h * 12 por hora)
tail -n 2016 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
```
