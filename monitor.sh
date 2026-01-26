#\!/bin/bash

# Monitor de recursos do radar-proxy
# Executa a cada 5 minutos via cron

LOG_FILE="/var/log/radar-monitor.log"
DATE=$(date "+%Y-%m-%d %H:%M:%S")

# Coleta métricas
MEM_TOTAL=$(free -m | awk '/Mem:/ {print $2}')
MEM_USED=$(free -m | awk '/Mem:/ {print $3}')
MEM_PERCENT=$((MEM_USED * 100 / MEM_TOTAL))

SWAP_TOTAL=$(free -m | awk '/Swap:/ {print $2}')
SWAP_USED=$(free -m | awk '/Swap:/ {print $3}')
SWAP_PERCENT=0
[ $SWAP_TOTAL -gt 0 ] && SWAP_PERCENT=$((SWAP_USED * 100 / SWAP_TOTAL))

CPU_LOAD=$(cat /proc/loadavg | awk '{print $1}')

PM2_MEM=$(pm2 jlist 2>/dev/null | grep -o '\"memory\":[0-9]*' | head -1 | grep -o '[0-9]*')
PM2_MEM_MB=$((PM2_MEM / 1024 / 1024))

CONNECTIONS=$(ss -s | grep "^TCP:" | awk '{print $2}')
HTTP_CONNS=$(ss -tn | grep -c ":3000\|:443")

PM2_RESTARTS=$(pm2 jlist 2>/dev/null | grep -o '\"restart_time\":[0-9]*' | head -1 | grep -o '[0-9]*')

# Formato: timestamp|mem_used_mb|mem_percent|swap_used_mb|swap_percent|cpu_load|pm2_mem_mb|connections|http_conns|pm2_restarts
echo "$DATE|$MEM_USED|$MEM_PERCENT|$SWAP_USED|$SWAP_PERCENT|$CPU_LOAD|$PM2_MEM_MB|$CONNECTIONS|$HTTP_CONNS|$PM2_RESTARTS" >> "$LOG_FILE"

# Mantém apenas últimos 7 dias (2016 linhas = 7 dias * 24h * 12 por hora)
tail -n 2016 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
