#\!/bin/bash
# ===========================================
# Verificação Periódica de Segurança
# Radar Futebol - VPS Proxy
# ===========================================

echo "========================================"
echo "  VERIFICAÇÃO DE SEGURANÇA - $(date)"
echo "========================================"
echo

# 1. Recursos do Sistema
echo "=== RECURSOS ==="
echo "RAM:"
free -h | grep -E "Mem|Swap"
echo
echo "Disco:"
df -h / | tail -1
echo
echo "Load:"
uptime
echo

# 2. Serviços
echo "=== SERVIÇOS ==="
echo -n "Nginx: " && systemctl is-active nginx
echo -n "Fail2ban: " && systemctl is-active fail2ban
echo -n "PM2/Proxy: " && pm2 pid radar-proxy > /dev/null 2>&1 && echo "active" || echo "inactive"
echo

# 3. Conexões
echo "=== CONEXÕES ==="
echo "Conexões TCP estabelecidas: $(ss -t state established | wc -l)"
echo "Conexões por estado:"
ss -s | grep TCP
echo

# 4. Fail2ban
echo "=== FAIL2BAN ==="
fail2ban-client status sshd 2>/dev/null || echo "Fail2ban não configurado para SSH"
echo

# 5. Nginx File Descriptors
echo "=== NGINX LIMITS ==="
NGINX_PID=$(pgrep -o nginx)
if [ -n "$NGINX_PID" ]; then
    cat /proc/$NGINX_PID/limits | grep "open files"
else
    echo "Nginx não está rodando\!"
fi
echo

# 6. Últimos logins SSH
echo "=== ÚLTIMOS LOGINS SSH ==="
last -5 2>/dev/null || echo "Sem dados de login"
echo

# 7. Tentativas de login falhas (últimas 24h)
echo "=== TENTATIVAS FALHAS (24h) ==="
FAILED=$(journalctl -u sshd --since "24 hours ago" 2>/dev/null | grep -c "Failed password" || echo "0")
echo "Tentativas falhas: $FAILED"
echo

# 8. Processos suspeitos
echo "=== PROCESSOS SUSPEITOS ==="
SUSPICIOUS=$(ps aux | grep -E "(miner|crypto|xmr|kinsing)" | grep -v grep | wc -l)
if [ "$SUSPICIOUS" -gt 0 ]; then
    echo "⚠️  ALERTA: $SUSPICIOUS processos suspeitos encontrados\!"
    ps aux | grep -E "(miner|crypto|xmr|kinsing)" | grep -v grep
else
    echo "✅ Nenhum processo suspeito"
fi
echo

# 9. Portas abertas
echo "=== PORTAS ABERTAS ==="
ss -tlnp | grep LISTEN
echo

# 10. PM2 Status
echo "=== PM2 STATUS ==="
pm2 status
echo

# 11. Health Check do Proxy
echo "=== HEALTH CHECK PROXY ==="
HEALTH=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/health 2>/dev/null)
if [ "$HEALTH" == "200" ]; then
    echo "✅ Proxy respondendo (HTTP $HEALTH)"
    curl -s http://localhost:3000/stats | head -c 200
    echo
else
    echo "⚠️  ALERTA: Proxy não respondendo (HTTP $HEALTH)"
fi
echo

# 12. Atualizações pendentes
echo "=== ATUALIZAÇÕES PENDENTES ==="
UPDATES=$(apt list --upgradable 2>/dev/null | grep -c upgradable || echo "0")
echo "Pacotes para atualizar: $UPDATES"
echo

echo "========================================"
echo "  Verificação concluída - $(date)"
echo "========================================"
