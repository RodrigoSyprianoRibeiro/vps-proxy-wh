#\!/bin/bash

LOG_FILE="/var/log/radar-monitor.log"

echo "========================================"
echo "   DIAGNÓSTICO DO RADAR-PROXY"
echo "   $(date)"
echo "========================================"
echo ""

# Verifica se tem dados suficientes
TOTAL_LINES=$(grep -v "^#" "$LOG_FILE" | wc -l)
echo "📊 Período analisado: $TOTAL_LINES amostras ($(($TOTAL_LINES * 5 / 60)) horas)"
echo ""

# Análise de Memória RAM
echo "═══ MEMÓRIA RAM ═══"
MEM_AVG=$(grep -v "^#" "$LOG_FILE" | awk -F"|" "{sum+=\$3} END {printf \"%.0f\", sum/NR}")
MEM_MAX=$(grep -v "^#" "$LOG_FILE" | awk -F"|" "BEGIN{max=0} {if(\$3>max)max=\$3} END {print max}")
MEM_OVER_80=$(grep -v "^#" "$LOG_FILE" | awk -F"|" "\$3 > 80 {count++} END {print count+0}")
MEM_OVER_90=$(grep -v "^#" "$LOG_FILE" | awk -F"|" "\$3 > 90 {count++} END {print count+0}")

echo "  Uso médio: ${MEM_AVG}%"
echo "  Uso máximo: ${MEM_MAX}%"
echo "  Vezes > 80%: $MEM_OVER_80"
echo "  Vezes > 90%: $MEM_OVER_90"
echo ""

# Análise de Swap
echo "═══ SWAP ═══"
SWAP_AVG=$(grep -v "^#" "$LOG_FILE" | awk -F"|" "{sum+=\$5} END {printf \"%.0f\", sum/NR}")
SWAP_MAX=$(grep -v "^#" "$LOG_FILE" | awk -F"|" "BEGIN{max=0} {if(\$5>max)max=\$5} END {print max}")
SWAP_USED_COUNT=$(grep -v "^#" "$LOG_FILE" | awk -F"|" "\$4 > 0 {count++} END {print count+0}")

echo "  Uso médio: ${SWAP_AVG}%"
echo "  Uso máximo: ${SWAP_MAX}%"
echo "  Vezes usando swap: $SWAP_USED_COUNT"
echo ""

# Análise de CPU
echo "═══ CPU (Load Average) ═══"
CPU_AVG=$(grep -v "^#" "$LOG_FILE" | awk -F"|" "{sum+=\$6} END {printf \"%.2f\", sum/NR}")
CPU_MAX=$(grep -v "^#" "$LOG_FILE" | awk -F"|" "BEGIN{max=0} {if(\$6>max)max=\$6} END {printf \"%.2f\", max}")
CPU_OVER_1=$(grep -v "^#" "$LOG_FILE" | awk -F"|" "\$6 > 1 {count++} END {print count+0}")

echo "  Load médio: $CPU_AVG"
echo "  Load máximo: $CPU_MAX"
echo "  Vezes load > 1: $CPU_OVER_1"
echo ""

# Análise PM2
echo "═══ PM2 (Node.js) ═══"
PM2_MEM_AVG=$(grep -v "^#" "$LOG_FILE" | awk -F"|" "{sum+=\$7} END {printf \"%.0f\", sum/NR}")
PM2_MEM_MAX=$(grep -v "^#" "$LOG_FILE" | awk -F"|" "BEGIN{max=0} {if(\$7>max)max=\$7} END {print max}")
PM2_RESTARTS=$(grep -v "^#" "$LOG_FILE" | tail -1 | awk -F"|" "{print \$10}")

echo "  Memória média: ${PM2_MEM_AVG}MB"
echo "  Memória máxima: ${PM2_MEM_MAX}MB"
echo "  Total de restarts: $PM2_RESTARTS"
echo ""

# Análise de Conexões
echo "═══ CONEXÕES ═══"
CONN_AVG=$(grep -v "^#" "$LOG_FILE" | awk -F"|" "{sum+=\$9} END {printf \"%.0f\", sum/NR}")
CONN_MAX=$(grep -v "^#" "$LOG_FILE" | awk -F"|" "BEGIN{max=0} {if(\$9>max)max=\$9} END {print max}")

echo "  Conexões HTTP médias: $CONN_AVG"
echo "  Conexões HTTP máximas: $CONN_MAX"
echo ""

# Diagnóstico Final
echo "========================================"
echo "   📋 DIAGNÓSTICO FINAL"
echo "========================================"

NEED_UPGRADE=0
REASONS=""

if [ $MEM_OVER_90 -gt 10 ]; then
    NEED_UPGRADE=1
    REASONS="$REASONS\n  ⚠️  RAM acima de 90% frequentemente ($MEM_OVER_90 vezes)"
fi

if [ $SWAP_MAX -gt 50 ]; then
    NEED_UPGRADE=1
    REASONS="$REASONS\n  ⚠️  Swap usado acima de 50% (máx: $SWAP_MAX%)"
fi

if [ $(echo "$CPU_MAX > 2" | bc -l) -eq 1 ]; then
    NEED_UPGRADE=1
    REASONS="$REASONS\n  ⚠️  CPU load muito alto (máx: $CPU_MAX)"
fi

if [ $PM2_RESTARTS -gt 10 ]; then
    NEED_UPGRADE=1
    REASONS="$REASONS\n  ⚠️  Muitos restarts do PM2 ($PM2_RESTARTS)"
fi

if [ $NEED_UPGRADE -eq 1 ]; then
    echo ""
    echo "  🔴 RECOMENDAÇÃO: FAZER UPGRADE DA VPS"
    echo ""
    echo "  Motivos:"
    echo -e "$REASONS"
    echo ""
    echo "  Sugestão: Droplet de 1GB RAM (\$6/mês) ou 2GB RAM (\$12/mês)"
else
    echo ""
    echo "  🟢 VPS ATUAL É SUFICIENTE"
    echo ""
    echo "  Os recursos estão dentro do aceitável."
    echo "  Continue monitorando por mais alguns dias."
fi

echo ""
echo "========================================"
