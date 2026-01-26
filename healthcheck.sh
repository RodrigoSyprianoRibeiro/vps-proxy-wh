#!/bin/bash

# Health check do radar-proxy
# Reinicia PM2 e Nginx se detectar falha

LOG_FILE="/var/log/radar-healthcheck.log"
MAX_FAILURES=3
FAILURE_COUNT_FILE="/tmp/radar-failures"

# Inicializa contador se não existir
[ ! -f "$FAILURE_COUNT_FILE" ] && echo 0 > "$FAILURE_COUNT_FILE"

# Testa o health check
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "http://127.0.0.1:3000/health" 2>/dev/null)

if [ "$HTTP_CODE" = "200" ]; then
    # Sucesso - reseta contador
    echo 0 > "$FAILURE_COUNT_FILE"
else
    # Falha - incrementa contador
    FAILURES=$(cat "$FAILURE_COUNT_FILE")
    FAILURES=$((FAILURES + 1))
    echo $FAILURES > "$FAILURE_COUNT_FILE"
    
    echo "$(date): Health check falhou (HTTP $HTTP_CODE) - Falha $FAILURES de $MAX_FAILURES" >> "$LOG_FILE"
    
    if [ $FAILURES -ge $MAX_FAILURES ]; then
        echo "$(date): Limite de falhas atingido. Reiniciando serviços..." >> "$LOG_FILE"
        
        # Reinicia PM2
        pm2 restart radar-proxy >> "$LOG_FILE" 2>&1
        
        # Reinicia Nginx
        systemctl restart nginx >> "$LOG_FILE" 2>&1
        
        # Reseta contador
        echo 0 > "$FAILURE_COUNT_FILE"
        
        echo "$(date): Serviços reiniciados" >> "$LOG_FILE"
    fi
fi
