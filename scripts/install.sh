#!/usr/bin/env bash
# Palco installer: builds, deploys to ~/.palco/app and registers the always-on service.
# Safe to re-run: it is also the update command.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PALCO_HOME="${PALCO_HOME:-$HOME/.palco}"
APP="$PALCO_HOME/app"

say() { printf '\033[1;33m▸\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✘ %s\033[0m\n' "$*" >&2; exit 1; }

command -v node >/dev/null || die "Node.js 20+ não encontrado. Instale com: brew install node"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node $NODE_MAJOR é antigo demais; precisa do 20 ou mais novo."
command -v git >/dev/null || die "git não encontrado. Instale as Command Line Tools: xcode-select --install"

say "Instalando dependências"
cd "$SRC"
npm ci --no-audit --no-fund --loglevel=error

say "Compilando"
npm run build --silent

# The service runs from ~/.palco/app, outside ~/Documents and ~/Desktop, so macOS privacy
# prompts for those folders never block it from starting at login.
say "Copiando para $APP"
mkdir -p "$APP"
rsync -a --delete --exclude .git --exclude .palco --exclude test "$SRC/" "$APP/"
chmod +x "$APP"/node_modules/node-pty/prebuilds/*/spawn-helper 2>/dev/null || true

if curl -fsS --max-time 2 "http://127.0.0.1:${PALCO_PORT:-4747}/api/health" >/dev/null 2>&1; then
  printf '\033[1;33m!\033[0m O Palco está rodando: atualizar reinicia o serviço e encerra os terminais abertos (o histórico fica salvo).\n'
  if [ -t 0 ]; then
    read -r -p "Continuar? [s/N] " ok
    case "$ok" in s|S|sim|y|Y) ;; *) die "Atualização cancelada. Os arquivos novos já estão em $APP; rode de novo quando quiser reiniciar." ;; esac
  fi
fi

say "Registrando o serviço"
node "$APP/dist/cli/palco.js" install

say "Abrindo o Palco"
node "$APP/dist/cli/palco.js" open

cat <<MSG

Pronto. Daqui em diante:
  palco           abre o Palco no navegador
  palco status    mostra se o serviço está no ar
  palco doctor    confere Node, agentes, Chrome e serviço
  palco logs      últimas linhas do log

Atualizar: rode este mesmo script de novo.
MSG
