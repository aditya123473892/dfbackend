#!/usr/bin/env sh
# Deploys or updates the backend on the server (api.darkfantasy.club).
# Run from the backend directory, after creating .env.production:
#   sh deploy/deploy.sh
# Pulls the newest published image, updates database indexes, restarts the API behind Caddy,
# then checks the public health endpoint over HTTPS.
set -eu

cd "$(dirname "$0")/.."
ENV_FILE=.env.production
COMPOSE="docker compose --env-file $ENV_FILE -f deploy/compose.production.yml"

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE. Copy .env.production.example to $ENV_FILE and fill it in." >&2
  exit 1
fi
if grep -Eq '<db_password>|^JWT_SECRET=$|^PASSWORD_ENCRYPTION_PRIVATE_KEY=$' "$ENV_FILE"; then
  echo "$ENV_FILE still has blank secrets (DATABASE_URL password, JWT_SECRET or PASSWORD_ENCRYPTION_PRIVATE_KEY)." >&2
  exit 1
fi

API_DOMAIN=$(sed -n 's/^API_DOMAIN=//p' "$ENV_FILE" | tail -n 1)

echo "Pulling the latest images..."
$COMPOSE pull

echo "Updating database indexes and starting the API..."
$COMPOSE up -d --remove-orphans

echo "Waiting for https://$API_DOMAIN/api/health/ready ..."
i=0
until curl -fsS "https://$API_DOMAIN/api/health/ready" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 36 ]; then
    echo "The API did not become healthy within 3 minutes. Recent logs:" >&2
    $COMPOSE logs --tail 80 migrate backend proxy >&2
    exit 1
  fi
  sleep 5
done

$COMPOSE ps
docker image prune -f >/dev/null
echo "Deployed: https://$API_DOMAIN/api is live."
