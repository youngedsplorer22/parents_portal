#!/usr/bin/env bash
# Samples the API process (CPU %, RSS KB) and PostgreSQL connections once per second while k6 runs.
#   API_PID=<pid> PGURL=postgresql://localhost/parents_portal_loadtest scripts/loadtest/sample.sh > sample.csv
# Several API processes (replicas): run one copy per PID and sum cpu/rss; the database columns are per database, so only one copy needs them. Needs psql. Stop with Ctrl-C. Columns: time,cpu_pct,rss_kb,total,active,idle,idle_in_tx,waiting_locks,max_connections,oldest_active_query_s
: "${API_PID:?set API_PID}" "${PGURL:?set PGURL (a disposable test database)}"
echo "time,cpu_pct,rss_kb,total,active,idle,idle_in_tx,waiting_locks,max_connections,oldest_active_query_s"
while kill -0 "$API_PID" 2>/dev/null; do
  proc=$(ps -o %cpu=,rss= -p "$API_PID" | awk '{print $1","$2}')
  db=$(psql "$PGURL" -At -F, -c "SELECT count(*), count(*) FILTER (WHERE state='active'), count(*) FILTER (WHERE state='idle'), count(*) FILTER (WHERE state='idle in transaction'), count(*) FILTER (WHERE wait_event_type='Lock'), current_setting('max_connections'), COALESCE(round(max(extract(epoch FROM now()-query_start)) FILTER (WHERE state='active')::numeric,2),0) FROM pg_stat_activity WHERE application_name='parents-portal'")
  echo "$(date +%T),$proc,$db"; sleep 1
done
