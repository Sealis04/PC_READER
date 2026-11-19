#!/usr/bin/env bash
# ======================================================================
# PC_READER server - guided setup for Linux and macOS (Docker only).
#
#   1. Development: this computer, database also on 127.0.0.1 for bun dev / tests.
#   2. Production:  this server; PCs on the LAN connect to http://<IP>:<port>.
#   Either one can add a Cloudflare Tunnel for an https address.
#
# Safe to run again: it keeps or backs up the env file (keeping the enrollment
# and secrets keys), re-applies the database password, and migrations only
# apply what is missing. setup.bat is the Windows twin; keep them in step.
# ======================================================================
set -uo pipefail
cd "$(dirname "$0")"

# ---------------------------------------------------------------- helpers

say() { printf '%s\n' "$*"; }

failed() {
  say ""
  say "Setup stopped. Fix the problem above and run ./setup.sh again;"
  say "finished steps are kept or are safe to repeat."
  exit 1
}

need_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    say "Docker is not installed. Install Docker Engine (or Docker Desktop on macOS), then run this again."
    return 1
  fi
  if ! docker info >/dev/null 2>&1; then
    say "Docker is not running, or this user may not use it. Start Docker, or add yourself to the"
    say "docker group (sudo usermod -aG docker \$USER, then log in again), and run this again."
    return 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    say "This Docker has no \"docker compose\" (the Compose v2 plugin). Install it, then run this again."
    return 1
  fi
}

# choice "Prompt" KEYS  -> echoes the chosen key (upper case), asks until one of KEYS is typed
choice() {
  local answer
  while true; do
    read -r -p "$1 " answer || exit 1
    answer=$(printf '%s' "$answer" | tr '[:lower:]' '[:upper:]')
    if [ ${#answer} -eq 1 ] && [[ "$2" == *"$answer"* ]]; then
      printf '%s' "$answer"
      return 0
    fi
  done
}

# ask VAR "Prompt" "default"
ask() {
  local answer
  if [ -n "${3:-}" ]; then read -r -p "$2 [$3]: " answer || exit 1; else read -r -p "$2: " answer || exit 1; fi
  printf -v "$1" '%s' "${answer:-${3:-}}"
}

# ask_required VAR "Prompt"
ask_required() {
  local answer=""
  while [ -z "$answer" ]; do
    read -r -p "$2: " answer || exit 1
    [ -z "$answer" ] && say "  This one is required."
  done
  printf -v "$1" '%s' "$answer"
}

randhex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
randb64() { head -c "$1" /dev/urandom | base64 | tr -d '\n'; }

# readfile FILE KEY default  -> echoes KEY's value from that env file, else default
readfile() {
  local line value="$3"
  [ -f "$1" ] || { printf '%s' "$value"; return 0; }
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in "$2="*) value="${line#*=}" ;; esac
  done < "$1"
  printf '%s' "$value"
}
readenv() { readfile "$ENVFILE" "$1" "$2"; }

# setenv KEY value  -> sets KEY=value in $ENVFILE, replacing its line or adding one
setenv() {
  local tmp found=0 line
  tmp=$(mktemp "$ENVFILE.XXXXXX") || return 1
  chmod 600 "$tmp"
  if [ -f "$ENVFILE" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        "$1="*) printf '%s=%s\n' "$1" "$2"; found=1 ;;
        *) printf '%s\n' "$line" ;;
      esac
    done < "$ENVFILE" > "$tmp"
  fi
  [ "$found" = 1 ] || printf '%s=%s\n' "$1" "$2" >> "$tmp"
  mv "$tmp" "$ENVFILE"
}

# confirm_app_port old new  -> on prod, asks before APP_PORT changes: every PC uses the old address.
confirm_app_port() {
  [ "$ENV" = prod ] && [ -n "$1" ] && [ "$1" != "$2" ] || return 0
  say ""
  say "Changing the port from $1 to $2 cuts off every PC: they keep using port $1."
  say "To change it safely, start the server on the new port as well and use"
  say "Settings > Server address on the dashboard, so the PCs follow first."
  [ "$(choice "Change the port to $2 anyway? [Y/N]" YN)" = Y ]
}

# env_file_choice  -> WRITE_ENV=1 when $ENVFILE should be (re)written; BACKUP = copy of the old one
env_file_choice() {
  WRITE_ENV=1
  BACKUP=""
  [ -f "$ENVFILE" ] || return 0
  say "$ENVFILE already exists here."
  if [ "$(choice "[K]eep it, or [R]eplace it (the old one is saved as $ENVFILE.bak-..., its keys can be kept)? [K/R]" KR)" = K ]; then
    WRITE_ENV=0
    return 0
  fi
  BACKUP="$ENVFILE.bak-$(date +%Y%m%d-%H%M%S)"
  cp -p "$ENVFILE" "$BACKUP" || return 1
  say "Saved the old file as $BACKUP"
  say ""
}

# pick_project  -> PROJECT stays the default unless an earlier `docker compose up` (run by hand,
# project named after the folder) left a database volume the user wants to keep using.
pick_project() {
  local vol vproj
  docker volume inspect "${PROJECT}_pgdata" >/dev/null 2>&1 && return 0
  for vol in $(docker volume ls -q --filter "label=com.docker.compose.volume=pgdata" 2>/dev/null); do
    vproj="${vol%_pgdata}"
    case "$vproj" in pcreader|pcreader-dev) continue ;; esac
    say "Found a database volume \"${vproj}_pgdata\" from an earlier docker compose run."
    if [ "$(choice "Is that this PC_READER server's data, to keep using? [Y/N]" YN)" = Y ]; then
      PROJECT="$vproj"
      say "Using project \"$PROJECT\", so its data is kept."
      say ""
      return 0
    fi
  done
}

# keys  -> ENROLLMENT_KEY, SECRETS_KEY, IT_PIN_SECRET: from $KEYSRC when asked, else new ones.
# A new SECRETS_KEY makes saved secret fields and stored recovery keys unreadable. ENROLLMENT_KEY
# only seeds the first recovery key of a new database; after that the server ignores it.
keys() {
  ENROLLMENT_KEY="" SECRETS_KEY="" IT_PIN_SECRET=""
  if [ -n "$KEYSRC" ]; then
    ENROLLMENT_KEY=$(readfile "$KEYSRC" ENROLLMENT_KEY "")
    SECRETS_KEY=$(readfile "$KEYSRC" SECRETS_KEY "")
    IT_PIN_SECRET=$(readfile "$KEYSRC" IT_PIN_SECRET "")
  fi
  if [ -n "$ENROLLMENT_KEY" ] && \
     [ "$(choice "Keep ENROLLMENT_KEY, SECRETS_KEY and IT_PIN_SECRET from $KEYSRC (Y unless you mean to change them)? [Y/N]" YN)" = N ]; then
    ENROLLMENT_KEY="" SECRETS_KEY="" IT_PIN_SECRET=""
  fi
  if [ -z "$ENROLLMENT_KEY" ]; then
    local gen
    gen=$(randhex 12)
    say "IT types the enrollment key when setting up each PC. Letters, digits and -, at least 12."
    say "It only seeds a new database: from then on the server keeps it as the recovery key,"
    say "makes a new one every 30 days and shows it on the dashboard (Settings). Changing it"
    say "here later has no effect on an existing database."
    while true; do
      ask ENROLLMENT_KEY "Enrollment key" "$gen"
      [[ "$ENROLLMENT_KEY" =~ ^[A-Za-z0-9-]{12,}$ ]] && break
      say "  Use at least 12 letters, digits or -."
    done
  fi
  [ -n "$SECRETS_KEY" ] || SECRETS_KEY=$(randb64 32)
}

# write_env  -> writes $ENVFILE from the variables set above. Never echoed to the screen.
write_env() {
  (umask 077 && cat > "$ENVFILE" <<EOF
# Written by setup.sh. Keep it private; Git ignores it.
# Read by docker compose through --env-file. See .env.example for what each value does.
COMPOSE_PROJECT_NAME=$PROJECT

# --- Server ---
# The first recovery key of a NEW database only. After that the server keeps the key, rotates it
# every 30 days and shows it on the dashboard (Settings); this value is then ignored.
ENROLLMENT_KEY=$ENROLLMENT_KEY
# Decrypts the secret custom fields. Back it up with the database; lost key = lost secrets.
SECRETS_KEY=$SECRETS_KEY
# Empty: the server keeps its own IT PIN secret in the database.
IT_PIN_SECRET=$IT_PIN_SECRET
DISPLAY_TIMEZONE=$DISPLAY_TIMEZONE
CHECKIN_INTERVAL_SECONDS=300

# --- Database ---
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
# Development only: the database on 127.0.0.1 for bun dev and tests.
DB_PORT=$DB_PORT

# --- Network ---
APP_PORT=$APP_PORT
# 0.0.0.0: PCs on the LAN connect directly. 127.0.0.1: only this computer and the tunnel.
APP_BIND=$APP_BIND
# https address of the Cloudflare Tunnel, if any (shown at the end of setup).
PUBLIC_URL=$PUBLIC_URL
CLOUDFLARE_TUNNEL_TOKEN=$CLOUDFLARE_TUNNEL_TOKEN
EOF
  )
}

show_used_ports() {
  local lines
  lines=$(docker ps --format '{{.Names}}  {{.Ports}}' 2>/dev/null | awk 'NF > 1')
  if [ -n "$lines" ]; then
    say "Ports already taken by running Docker containers:"
    printf '%s\n' "$lines" | sed 's/^/  /'
    say ""
  fi
}

# port_holder PORT own  -> echoes what uses PORT on this computer; empty when it is free or held
# by our own container `own` (docker compose recreates that one).
port_holder() {
  local names name holder=""
  names=$(docker ps --filter "publish=$1" --format '{{.Names}}' 2>/dev/null)
  for name in $names; do
    [ "$name" = "$2" ] && return 0
    [ -z "$holder" ] && holder="Docker container $name"
  done
  if [ -n "$holder" ]; then printf '%s' "$holder"; return 0; fi
  if command -v ss >/dev/null 2>&1; then
    local proc
    if [ -n "$(ss -Hltn "sport = :$1" 2>/dev/null)" ]; then
      proc=$(ss -Hltnp "sport = :$1" 2>/dev/null | grep -o 'users:(("[^"]*",pid=[0-9]*' | head -n1 | sed 's/users:(("\([^"]*\)",pid=\([0-9]*\)/program \1, PID \2/')
      printf '%s' "${proc:-another program}"
    fi
  elif command -v lsof >/dev/null 2>&1; then
    local row
    row=$(lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | awk 'NR == 2 { print "program " $1 ", PID " $2 }')
    if [ -n "$row" ]; then printf '%s' "$row"
    elif (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; then printf 'another program'
    fi
  fi
}

# free_port START own  -> echoes the first port from START up that port_holder finds free
free_port() {
  local p="$1"
  while [ "$p" -lt $(($1 + 100)) ] && [ -n "$(port_holder "$p" "$2")" ]; do p=$((p + 1)); done
  printf '%s' "$p"
}

# ask_port VAR "Prompt" default own  -> asks for a port, suggesting the first free one from
# `default`; if the answer is taken, says by what and asks again.
ask_port() {
  local suggest="$3" holder value
  holder=$(port_holder "$3" "$4")
  if [ -n "$holder" ]; then
    say "  Port $3 is already used by $holder."
    suggest=$(free_port "$3" "$4")
    say "  Suggesting $suggest instead."
  fi
  while true; do
    ask value "$2" "$suggest"
    if ! [[ "$value" =~ ^[0-9]+$ ]] || [ "$value" -lt 1 ] || [ "$value" -gt 65535 ]; then
      say "  Enter a port number from 1 to 65535."
      continue
    fi
    holder=$(port_holder "$value" "$4")
    if [ -z "$holder" ]; then
      printf -v "$1" '%s' "$value"
      return 0
    fi
    say "  Port $value is already used by $holder."
    suggest=$(free_port "$value" "$4")
  done
}

# ensure_port KEY own  -> if the port in KEY is taken by anything but our own container, name the
# holder, ask for another port (a free one suggested), save it and check again.
ensure_port() {
  local port holder new
  port=$(readenv "$1" "$3")
  while holder=$(port_holder "$port" "$2"); [ -n "$holder" ]; do
    say ""
    say "Port $port on this computer is already used by $holder."
    ask new "Port to use instead" "$(free_port "$port" "$2")"
    if [ "$1" = APP_PORT ] && ! confirm_app_port "$port" "$new"; then
      say "Free port $port (stop $holder), then run ./setup.sh again."
      return 1
    fi
    setenv "$1" "$new" || return 1
    port="$new"
  done
}

# wait_health url  -> polls for up to 5 minutes, prints the answer
wait_health() {
  say "Waiting for $1 ..."
  local i
  for i in $(seq 1 60); do
    if curl -fsS "$1" >/dev/null 2>&1; then
      curl -s "$1"
      say ""
      return 0
    fi
    sleep 5
  done
  say "No answer after 5 minutes. See what the server says with:"
  say "  $DC logs app"
  return 1
}

# run_step command...  -> a step with a Try again / Skip / Quit menu when it fails.
run_step() {
  while true; do
    "$@" && return 0
    say ""
    say "That step failed, see the message above."
    case "$(choice "[T]ry again, [S]kip or [Q]uit:" TSQ)" in
      S) return 0 ;;
      Q) return 1 ;;
    esac
  done
}

dc() { docker compose -p "$PROJECT" --env-file "$ENVFILE" "${FILES[@]}" "$@"; }

tunnel_help() {
  say ""
  say "Cloudflare: Zero Trust - Networks - Tunnels - Create a tunnel - Cloudflared - Docker."
  say "Copy only the long token after \"--token \"."
  say "Then add a public hostname: your address, Service HTTP, URL app:3000 (not localhost)."
  say ""
}

# ask_tunnel  -> optional Cloudflare Tunnel; writes its settings into $ENVFILE
ask_tunnel() {
  say "An https address through Cloudflare lets PCs outside the office reach the server."
  say "The dashboard has no login yet, so it then needs Cloudflare Access in front."
  [ "$(choice "Add a Cloudflare Tunnel? [Y/N]" YN)" = Y ] || return 0
  tunnel_help
  local url token
  while true; do
    ask_required url "Public address, e.g. https://pcreader.example.gov.ph"
    url="${url%/}"
    [[ "$url" == https://* ]] && break
    say "  It must start with https://"
  done
  read -r -s -p "Tunnel token, saved only in $ENVFILE (not shown): " token || exit 1
  say ""
  while [ -z "$token" ]; do
    say "  This one is required."
    read -r -s -p "Tunnel token: " token || exit 1
    say ""
  done
  setenv PUBLIC_URL "$url" || return 1
  setenv CLOUDFLARE_TUNNEL_TOKEN "$token" || return 1
  say "Saved the tunnel settings."
}

lan_addresses() {
  local ips=""
  if command -v hostname >/dev/null 2>&1 && hostname -I >/dev/null 2>&1; then
    ips=$(hostname -I)
  elif command -v ipconfig >/dev/null 2>&1; then
    ips=$(for i in en0 en1 en2; do ipconfig getifaddr "$i" 2>/dev/null; done)
  fi
  local ip
  for ip in $ips; do
    case "$ip" in 127.*|169.254.*|172.1[7-9].*|172.2[0-9].*|172.3[01].*|*:*) continue ;; esac
    say "  http://$ip:$APP_PORT"
  done
}

firewall_hint() {
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    say "ufw is active. Let PCs on the LAN in, e.g. for 192.168.0.0/16:"
    say "  sudo ufw allow from 192.168.0.0/16 to any port $APP_PORT proto tcp"
  elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    say "firewalld is active. Let PCs on the LAN in:"
    say "  sudo firewall-cmd --permanent --add-port=$APP_PORT/tcp && sudo firewall-cmd --reload"
  fi
}

# ---------------------------------------------------------------- main

say ""
say " PC_READER setup"
say " ==============="
say ""
need_docker || failed

say "Which setup is this?"
say "  1. Development  - this computer, for trying it out and working on the code"
say "  2. Production   - the server the agency's PCs report to"
if [ "$(choice "Pick 1 or 2:" 12)" = 2 ]; then ENV=prod; else ENV=dev; fi
say ""

if [ "$ENV" = dev ]; then
  PROJECT=pcreader-dev
  ENVFILE=.env
  FILES=(-f docker-compose.yml -f compose.local.yml)
else
  PROJECT=pcreader
  ENVFILE=.env.prod
  FILES=(-f docker-compose.yml)
fi

env_file_choice || failed

# KEYSRC: an older env file whose keys a new one should keep. PROJSRC: where the project name is.
KEYSRC="" PROJSRC=""
if [ "$WRITE_ENV" = 0 ]; then
  PROJSRC="$ENVFILE"
elif [ -n "$BACKUP" ]; then
  KEYSRC="$BACKUP" PROJSRC="$BACKUP"
elif [ "$ENV" = prod ] && [ -f .env ]; then
  KEYSRC=.env
fi

SAVED_PROJECT=""
[ -n "$PROJSRC" ] && SAVED_PROJECT=$(readfile "$PROJSRC" COMPOSE_PROJECT_NAME "")
if [ -n "$SAVED_PROJECT" ]; then PROJECT="$SAVED_PROJECT"; else pick_project || failed; fi
DC="docker compose -p $PROJECT --env-file $ENVFILE ${FILES[*]}"

if [ "$WRITE_ENV" = 0 ]; then
  setenv COMPOSE_PROJECT_NAME "$PROJECT" || failed
else
  say "Press Enter to accept the value in [brackets]."
  show_used_ports
  # A prod re-run suggests the port PCs already use and asks before changing it.
  OLD_APP_PORT=""
  [ "$ENV" = prod ] && [ -n "$BACKUP" ] && OLD_APP_PORT=$(readfile "$BACKUP" APP_PORT "")
  while true; do
    ask_port APP_PORT "Port PCs and browsers use to reach the server" "${OLD_APP_PORT:-3000}" "$PROJECT-app-1"
    confirm_app_port "$OLD_APP_PORT" "$APP_PORT" && break
  done
  DB_PORT=""
  [ "$ENV" = dev ] && ask_port DB_PORT "Port for the database on this computer, for bun dev and tests only" 5432 "$PROJECT-db-1"

  OLD_TZ="Asia/Manila"
  [ -n "$KEYSRC" ] && OLD_TZ=$(readfile "$KEYSRC" DISPLAY_TIMEZONE "Asia/Manila")
  say "Time zone of the dashboard, the inventory number year and the hourly IT PIN."
  ask DISPLAY_TIMEZONE "IANA time zone" "$OLD_TZ"

  keys
  POSTGRES_PASSWORD=$(randhex 24)
  APP_BIND=0.0.0.0 PUBLIC_URL="" CLOUDFLARE_TUNNEL_TOKEN=""
  write_env || failed
  say ""
  say "Wrote $ENVFILE with a new random database password."
  if [ "$ENV" = prod ]; then
    say ""
    say "IMPORTANT: copy $ENVFILE into your password manager now. SECRETS_KEY in it"
    say "decrypts the secret custom fields; without it they are lost with this server."
    say ""
    read -r -p "Press Enter to go on. " _ || exit 1
  fi
  say ""
  ask_tunnel || failed
fi

# ---------------------------------------------------------------- shared steps

ensure_port APP_PORT "$PROJECT-app-1" 3000 || failed
[ "$ENV" = dev ] && { ensure_port DB_PORT "$PROJECT-db-1" 5432 || failed; }
APP_PORT=$(readenv APP_PORT 3000)
APP_BIND=$(readenv APP_BIND 0.0.0.0)
DB_PORT=$(readenv DB_PORT 5432)
PUBLIC_URL=$(readenv PUBLIC_URL "")
if [ -z "$(readenv ENROLLMENT_KEY "")" ]; then
  say "$ENVFILE has no ENROLLMENT_KEY. Run ./setup.sh again and choose Replace."
  failed
fi
PROFILE=()
[ -n "$(readenv CLOUDFLARE_TUNNEL_TOKEN "")" ] && PROFILE=(--profile tunnel)
PROFILE_TXT="${PROFILE[*]:-}"

say ""
say "[1/5] Building the server image. The first build takes a few minutes..."
run_step dc build migrate app || failed

say ""
say "[2/5] Starting the database..."
run_step dc up -d --wait db || failed

say ""
say "[3/5] Setting the database password from $ENVFILE..."
# Postgres takes POSTGRES_PASSWORD only when it creates its volume. Apply it to an
# existing volume as well, so a re-written $ENVFILE still matches the data.
reset_db_password() { dc exec -T db sh < scripts/reset-db-password.sh; }
run_step reset_db_password || failed

say ""
say "[4/5] Applying database migrations..."
run_step dc run --rm migrate || failed

say ""
say "[5/5] Starting the server..."
run_step dc ${PROFILE[@]+"${PROFILE[@]}"} up -d || failed
wait_health "http://127.0.0.1:$APP_PORT/api/branding" || failed

say ""
say "======================================================================"
say " Ready. Dashboard: http://localhost:$APP_PORT"
say "======================================================================"
say ""
if [ "$APP_BIND" != 127.0.0.1 ]; then
  say "PCs on the network use one of these server addresses:"
  lan_addresses
  firewall_hint
fi
[ -n "$PUBLIC_URL" ] && say "Through the tunnel: $PUBLIC_URL"
say ""
say "Setting up a PC: install the desktop app, enter the server address above,"
say "the recovery key (dashboard Settings > Recovery key > Show key; on a new"
say "database it is ENROLLMENT_KEY in $ENVFILE) and the current IT PIN"
say "from http://localhost:$APP_PORT/it-pin"
say ""
say "After a code change or git pull, rebuild and restart (migrations run on start):"
say "  $DC${PROFILE_TXT:+ $PROFILE_TXT} up -d --build"
say "Stop it - the data stays in Docker volumes:"
say "  $DC${PROFILE_TXT:+ $PROFILE_TXT} down"
say "Logs:"
say "  $DC logs -f app"
say ""

if [ "$ENV" = dev ]; then
  say "To run the server with bun dev instead, keep this database running and"
  say "stop only the app container:"
  say "  $DC stop app"
  say "  cd server && DATABASE_URL=postgres://pcreader:<POSTGRES_PASSWORD from .env>@127.0.0.1:$DB_PORT/pcreader bun run dev"
  say ""
else
  say "Still to do by hand:"
  say " - The dashboard has no login yet: anyone who can open it can read the IT PIN."
  say "   Keep it on the office network."
  say " - Start Docker at boot (sudo systemctl enable docker; on macOS, Docker Desktop"
  say "   'Start when you sign in') and keep the server from sleeping."
  say " - Keep $ENVFILE in a password manager. A lost SECRETS_KEY means lost secret fields."
  say " - Give this server a fixed IP (DHCP reservation) or a name such as"
  say "   pcreader.office.local, so PCs keep finding it. To move it later, use"
  say "   Settings > Server address on the dashboard."
  say " - Back up regularly, e.g. a nightly cron job:"
  say "     $DC exec -T db pg_dump -U pcreader -Fc pcreader > pcreader.dump"
  say ""
fi

if [ ${#PROFILE[@]} -eq 0 ]; then
  say "To add a Cloudflare Tunnel later, run ./setup.sh again and choose Replace;"
  say "SECRETS_KEY and the other keys are kept."
else
  say "Tunnel is on. In Cloudflare:"
  say " - The public hostname must point to Service HTTP, URL app:3000. The tunnel"
  say "   should show HEALTHY."
  say " - Put a Cloudflare Access application on the hostname: the dashboard has no"
  say "   login and shows the IT PIN. Add a Bypass policy for the paths PCs use:"
  say "   /api/agent/* and /api/branding* (they carry their own token / are public)."
  say " - This server must stay awake, or Cloudflare shows error 1033."
fi
say ""
