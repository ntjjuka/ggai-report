#!/usr/bin/env bash
# E2E 스모크: 업로드 → 참여자 확인 → 보고서 생성 → 완료 폴링 → 공유 → 카드 PNG → 삭제
# 사용: BASE_URL=http://localhost:3000 bash scripts/smoke.sh  (web + worker 가 떠 있어야 함)
set -euo pipefail
BASE="${BASE_URL:-http://localhost:3000}"
# 기본 픽스처는 기본 한도(UPLOAD_MIN_MESSAGES=30)에서도 통과하는 304개짜리. 3인 대화 샘플은 FIXTURE=docs/fixtures/android_ko_basic.txt (UPLOAD_MIN_MESSAGES≤16 필요)
FIXTURE="${FIXTURE:-docs/fixtures/group_30people.txt}"
JAR="$(mktemp)"
OUT="$(mktemp -d)"
j() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(eval('d'+sys.argv[2]))" "$1" "$2"; }

echo "1) upload"
code=$(curl -s -o "$OUT/up.json" -w "%{http_code}" -c "$JAR" -b "$JAR" -F "files=@$FIXTURE" -F "focus=FRIEND_ONE" "$BASE/api/v1/conversations")
[ "$code" = "201" ] || { echo "upload failed: $code"; cat "$OUT/up.json"; exit 1; }
CID=$(j "$OUT/up.json" "['conversationId']")
SIG=$(j "$OUT/up.json" "['signal']['grade']" 2>/dev/null || echo none)
case "$SIG" in EXCELLENT|GOOD|FAIR|WEAK) ;; *) echo "signal missing in upload response: $SIG"; exit 1;; esac
echo "   conversation=$CID messages=$(j "$OUT/up.json" "['messageCount']") signal=$SIG ($(j "$OUT/up.json" "['signal']['label']"))"

echo "2) confirm participants (uploader = first)"
UP=$(j "$OUT/up.json" "['participants'][0]['participantId']")
BOT_EXCLUDES=$(python3 -c "import json; d=json.load(open('$OUT/up.json')); print(json.dumps([p['participantId'] for p in d['participants'] if p['isBot']]))")
code=$(curl -s -o "$OUT/confirm.json" -w "%{http_code}" -b "$JAR" -H 'Content-Type: application/json' -X POST "$BASE/api/v1/conversations/$CID/participants/confirm" -d "{\"uploaderParticipantId\":\"$UP\",\"merges\":[],\"excluded\":$BOT_EXCLUDES,\"displayNames\":{},\"title\":\"스모크 테스트\"}")
[ "$code" = "200" ] || { echo "confirm failed: $code"; cat "$OUT/confirm.json"; exit 1; }

echo "3) create report"
code=$(curl -s -o "$OUT/rep.json" -w "%{http_code}" -b "$JAR" -H 'Content-Type: application/json' -X POST "$BASE/api/v1/conversations/$CID/reports" -d '{"focus":"FRIEND_ONE","tone":"CASUAL","focusQuestion":"얘 나한테 관심 있어?"}')
[ "$code" = "202" ] || { echo "create failed: $code"; cat "$OUT/rep.json"; exit 1; }
SEQ=$(j "$OUT/rep.json" "['seq']")
RID=$(j "$OUT/rep.json" "['reportId']")

echo "4) poll"
for i in $(seq 1 60); do
  curl -s -o "$OUT/status.json" -b "$JAR" "$BASE/api/v1/conversations/$CID/reports/$SEQ"
  ST=$(j "$OUT/status.json" "['status']")
  PCT=$(j "$OUT/status.json" "['progress']['pct']")
  echo "   $ST $PCT%"
  case "$ST" in SUCCEEDED) break;; FAILED|CANCELED) echo "report $ST"; cat "$OUT/status.json"; exit 1;; esac
  sleep 2
done
[ "$ST" = "SUCCEEDED" ] || { echo "timeout waiting for report"; exit 1; }
echo "   headline: $(j "$OUT/status.json" "['content']['verdict']['headline']")"
echo "   scores: $(j "$OUT/status.json" "['content']['scores'].__len__()") findings: $(j "$OUT/status.json" "['content']['findings'].__len__()") coverage: $(j "$OUT/status.json" "['content']['meta']['coveragePct']")%"

echo "5) share"
curl -s -o "$OUT/share.json" -b "$JAR" -X POST "$BASE/api/v1/reports/$RID/share/enable"
URL=$(j "$OUT/share.json" "['url']")
TOKEN="${URL##*/}"
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/r/$TOKEN")
[ "$code" = "200" ] || { echo "shared page failed: $code"; exit 1; }
code=$(curl -s -o "$OUT/card.png" -w "%{http_code}" "$BASE/r/$TOKEN/card.png")
[ "$code" = "200" ] || { echo "card failed: $code"; exit 1; }
echo "   shared url ok, card.png $(stat -c %s "$OUT/card.png") bytes"
curl -s -o /dev/null -b "$JAR" -X POST "$BASE/api/v1/reports/$RID/share/disable"
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/v1/shared/$TOKEN")
[ "$code" = "404" ] || { echo "share disable failed: $code"; exit 1; }

echo "5b) single report delete (409 while queued → cancel → 204 → 404)"
code=$(curl -s -o "$OUT/rep2.json" -w "%{http_code}" -b "$JAR" -H 'Content-Type: application/json' -X POST "$BASE/api/v1/conversations/$CID/reports" -d '{"focus":"AUTO","tone":"CASUAL","focusQuestion":null}')
[ "$code" = "202" ] || { echo "second report failed: $code"; cat "$OUT/rep2.json"; exit 1; }
RID2=$(j "$OUT/rep2.json" "['reportId']")
code=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR" -X DELETE "$BASE/api/v1/reports/$RID2")
[ "$code" = "409" ] || { echo "delete while queued/running should be 409: $code"; exit 1; }
curl -s -o /dev/null -b "$JAR" -X POST "$BASE/api/v1/reports/$RID2/cancel"
code=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR" -X DELETE "$BASE/api/v1/reports/$RID2")
[ "$code" = "204" ] || { echo "report delete failed: $code"; exit 1; }
code=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR" "$BASE/api/v1/reports/$RID2")
[ "$code" = "404" ] || { echo "deleted report should be 404: $code"; exit 1; }
code=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR" "$BASE/api/v1/conversations/$CID/reports/$SEQ")
[ "$code" = "200" ] || { echo "first report should survive: $code"; exit 1; }
echo "   ok"

echo "6) pages"
code=$(curl -s -o "$OUT/list.json" -w "%{http_code}" -b "$JAR" "$BASE/api/v1/conversations")
[ "$code" = "200" ] || { echo "list failed: $code"; exit 1; }
[ "$(j "$OUT/list.json" "['conversations'][0]['conversationId']")" = "$CID" ] || { echo "list missing conversation"; exit 1; }
for p in "/" "/my" "/setup" "/guide/export" "/c/$CID" "/c/$CID/story" "/c/$CID/reports/$SEQ"; do
  code=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR" "$BASE$p")
  [ "$code" = "200" ] || { echo "page $p failed: $code"; exit 1; }
done

if [ "${KEEP:-0}" != "1" ]; then
  echo "7) delete"
  code=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR" -X DELETE "$BASE/api/v1/conversations/$CID")
  [ "$code" = "204" ] || { echo "delete failed: $code"; exit 1; }
  code=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR" "$BASE/api/v1/conversations/$CID")
  [ "$code" = "404" ] || { echo "post-delete lookup should be 404: $code"; exit 1; }
else
  echo "KEEP=1: conversation=$CID seq=$SEQ cookie-jar=$JAR"
fi
echo "SMOKE OK"
