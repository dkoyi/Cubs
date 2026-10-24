#!/usr/bin/env bash
# Creates one access key for the Bedrock-only IAM user "supercub-judge" (already created,
# policy: invoke Anthropic models only), verifies it against Bedrock, and stores it as
# production env vars on the linked Vercel project. The secret never prints.
set -euo pipefail
export AWS_PROFILE=sandbox2025 AWS_REGION=us-east-1
umask 077

aws iam create-access-key --user-name supercub-judge --output json > /tmp/supercub-key.json
AKID=$(python3 -I -c "import json;print(json.load(open('/tmp/supercub-key.json'))['AccessKey']['AccessKeyId'])")
SECRET=$(python3 -I -c "import json;print(json.load(open('/tmp/supercub-key.json'))['AccessKey']['SecretAccessKey'])")
echo "key id: $AKID"

echo "verifying the key against Bedrock (IAM can take a few seconds to propagate)..."
ok=0
for i in 1 2 3 4 5 6; do
  if env -u AWS_PROFILE AWS_ACCESS_KEY_ID=$AKID AWS_SECRET_ACCESS_KEY=$SECRET \
     aws bedrock-runtime converse --region us-east-1 --model-id global.anthropic.claude-opus-5-5 \
     --messages '[{"role":"user","content":[{"text":"Reply OK"}]}]' --inference-config '{"maxTokens":3}' \
     --output text --query 'output.message.content[0].text' >/dev/null 2>/tmp/bedrock-err.txt; then
    echo "bedrock call with new key: works"; ok=1; break
  fi
  sleep 5
done
if [ $ok = 0 ]; then echo "bedrock call failed:"; head -c 300 /tmp/bedrock-err.txt; echo; fi

cd "$(dirname "$0")/../server"
echo "vercel account: $(pnpm dlx vercel whoami 2>/dev/null | tail -1)"
for kv in "AWS_ACCESS_KEY_ID=$AKID" "AWS_SECRET_ACCESS_KEY=$SECRET" "AWS_REGION=us-east-1" "SUPERCUB_MODEL=global.anthropic.claude-opus-5-5"; do
  k=${kv%%=*}; v=${kv#*=}
  pnpm dlx vercel env rm "$k" production --yes >/dev/null 2>&1 || true
  printf '%s' "$v" | pnpm dlx vercel env add "$k" production >/dev/null 2>&1 && echo "set $k"
done
echo "production env now has:"
pnpm dlx vercel env ls production 2>/dev/null | grep -E "AWS_|SUPERCUB_|KV_" | awk '{print "  " $1}'
rm -f /tmp/supercub-key.json
echo "done. Redeploy for the server to pick these up."
