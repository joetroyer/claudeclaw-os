#!/bin/bash
# Bank fresh Zoom recordings from n8n into store/recordings/ before the
# 24h JWT download_token expires. Run via cron hourly.
#
# Usage: scripts/bank-recordings.sh
# Env:   reads N8N_API_URL + N8N_API_KEY from .env
# Logs:  ~/Library/Logs/clawos/bank-recordings-YYYY-MM-DD.log

set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env"
DEST="$PROJECT_ROOT/store/recordings"
LOG_DIR="$HOME/Library/Logs/clawos"
LOG_FILE="$LOG_DIR/bank-recordings-$(date +%Y-%m-%d).log"
WORKFLOW_ID="oWmSJf851EFlDPJn"  # Zoom Recording > Slack
LOOKBACK_LIMIT=20

mkdir -p "$DEST" "$LOG_DIR"
exec >>"$LOG_FILE" 2>&1
echo "=== bank-recordings $(date '+%Y-%m-%d %H:%M:%S') ==="

N8N_URL=$(grep '^N8N_API_URL=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r')
N8N_KEY=$(grep '^N8N_API_KEY=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r')
[ -z "$N8N_URL" ] || [ -z "$N8N_KEY" ] && { echo "ERR: N8N_API_URL/KEY missing"; exit 1; }

# Pull recent executions, extract uuid for each (dedup by uuid via DEST glob).
EXECS=$(curl -sf -H "X-N8N-API-KEY: $N8N_KEY" \
  "$N8N_URL/api/v1/executions?workflowId=$WORKFLOW_ID&limit=$LOOKBACK_LIMIT" \
  | python3 -c "import sys,json; print(' '.join(e['id'] for e in json.load(sys.stdin).get('data',[])))")

NEW=0; SKIP=0; FAIL=0
for EID in $EXECS; do
  RAW=$(curl -sf -H "X-N8N-API-KEY: $N8N_KEY" "$N8N_URL/api/v1/executions/$EID?includeData=true" || echo '')
  [ -z "$RAW" ] && { FAIL=$((FAIL+1)); continue; }
  RESULT=$(DEST="$DEST" EID="$EID" RAW="$RAW" python3 - <<'PYEOF'
import sys, json, os, urllib.request, urllib.error, re, datetime
d = json.loads(os.environ['RAW'])
runs = d.get('data',{}).get('resultData',{}).get('runData',{})
for node, lst in runs.items():
    if 'Webhook' not in node: continue
    body = lst[0].get('data',{}).get('main',[[]])[0][0].get('json',{}).get('body',{})
    if body.get('event') != 'recording.completed':
        print('SKIP:not_recording'); sys.exit()
    obj = body.get('payload',{}).get('object',{})
    uuid = obj.get('uuid','').replace('/','_').replace('+','-').replace('=','')
    if not uuid: print('SKIP:no_uuid'); sys.exit()
    topic = re.sub(r'[^a-zA-Z0-9]+','-', obj.get('topic',''))[:40].strip('-') or 'unnamed'
    start = (obj.get('start_time','') or '')[:10] or 'undated'
    fname = f'{start}_{topic}_{uuid[:8]}.m4a'
    path = os.path.join(os.environ['DEST'], fname)
    if os.path.exists(path) and os.path.getsize(path) > 1000:
        print('SKIP:already_banked'); sys.exit()
    files = obj.get('recording_files',[])
    m4a = next((f for f in files if (f.get('file_type') or '').upper() in ('M4A','AUDIO_ONLY')), None)
    if not m4a: print('SKIP:no_audio'); sys.exit()
    token = body.get('download_token','')
    try:
        req = urllib.request.Request(m4a['download_url'], headers={'Authorization': f'Bearer {token}'})
        with urllib.request.urlopen(req, timeout=180) as r, open(path,'wb') as out:
            sz = 0
            while chunk := r.read(1<<20):
                out.write(chunk); sz += len(chunk)
        with open(path.replace('.m4a','.meta.json'),'w') as mf:
            json.dump({'uuid':obj.get('uuid'),'topic':obj.get('topic'),'duration':obj.get('duration'),
                       'start_time':obj.get('start_time'),'share_url':obj.get('share_url'),
                       'execution_id':os.environ['EID'],
                       'banked_at':datetime.datetime.now(datetime.UTC).isoformat()}, mf, indent=2)
        print(f'NEW:{sz//1024}KB:{fname}')
    except urllib.error.HTTPError as e:
        print(f'FAIL:HTTP{e.code}:{fname}')
    except Exception as e:
        print(f'FAIL:{type(e).__name__}:{fname}')
    sys.exit()
print('SKIP:no_webhook_node')
PYEOF
)
  case "$RESULT" in
    NEW:*)  NEW=$((NEW+1));  echo "  $EID $RESULT" ;;
    SKIP:*) SKIP=$((SKIP+1)) ;;
    FAIL:*) FAIL=$((FAIL+1)); echo "  $EID $RESULT" ;;
  esac
done

echo "summary: $NEW new, $SKIP skipped, $FAIL failed"
exit 0
