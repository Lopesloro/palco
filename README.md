# Palco

Espaço de trabalho local para agentes de código. Terminais com Claude Code, Codex, OpenCode, Gemini ou um shell ficam lado a lado num canvas infinito, junto com notas em Markdown e portais de navegador. Você liga os cards com cordas, e os agentes ligados conversam entre si pela CLI `palco`.

Tudo roda na sua máquina, em `http://127.0.0.1:4747`, como um serviço que sobe no login e reinicia sozinho se cair. Não há conta, telemetria nem nuvem. Os dados ficam em `~/.palco` (JSON e Markdown).

## Instalar (macOS)

Precisa de Node 20+, git e, para os portais, Google Chrome.

```bash
git clone https://github.com/Lopesloro/palco.git && cd palco && ./scripts/install.sh
```

O script compila, copia o app para `~/.palco/app`, registra o serviço do launchd (`app.palco.server`), cria o comando `palco` em `~/.local/bin` e instala a skill dos agentes em `~/.claude/skills/palco` (e `~/.codex/skills/palco`, se existir). Para atualizar, rode o mesmo script.

Depois disso, um comando abre tudo:

```bash
palco
```

| Comando | O que faz |
|---|---|
| `palco` | sobe o serviço se preciso e abre o navegador |
| `palco status` | mostra se está no ar |
| `palco doctor` | confere Node, agentes instalados, Chrome e serviço |
| `palco logs` / `palco logs -f` | log do serviço |
| `palco stop` / `start` / `restart` | controla o serviço |
| `palco uninstall` | remove o serviço (os dados ficam em `~/.palco`) |

## O que tem

- **Canvas infinito** com zoom, minimapa, seleção múltipla, caneta, setas e retângulos.
- **Terminais de agentes** (xterm.js sobre PTY real), um por card, com status ao vivo: iniciando, trabalhando ou esperando.
- **Chat** em cada terminal: troca para uma conversa formatada; o agente responde com `palco say` e pode mandar imagens e arquivos.
- **Cordas**: agente com agente (conversam), agente com nota (lê e escreve), agente com portal (navega), nota com nota (corrente de contexto).
- **Notas** em Markdown, com cor, cadeado (só leitura para agentes) e fichários.
- **Portais**: um Chrome headless por card, transmitido ao vivo; você clica e digita nele, e o agente usa `palco portal snapshot/click/fill/...`. Modos iPhone e Android.
- **Bands**: equipes em que todos se alcançam; o card lista quem está trabalhando.
- **Roles** (instruções reutilizáveis, por workspace ou globais) e **presets** de agentes.
- **Andares**: cópias isoladas do projeto. Em repositório git viram `git worktree` num branch próprio; fora de git, um clone copy-on-write (APFS). `palco floor land` integra de volta.
- **Routines**: prompts, comandos ou lembretes agendados (`--every 30m`, `--at 09:00`, cron ou data única).
- **Partituras**: salve uma equipe (agentes, roles, notas e cordas) e coloque de novo com um clique.
- **Compositor** (`⌘K`): um prompt para vários terminais, com `@`menções e imagens coladas.
- **Importação do Maestri**: em Configurações, traz workspaces de `~/.maestri` (terminais, notas e cordas) sem alterar a origem.

## Agentes conversando

Dentro de qualquer terminal do Palco:

```bash
palco list                                   # quem está ligado a você
palco ask "Revisor" "revise o diff atual"     # espera a resposta
palco ask --batch '{"A":"testes","B":"docs"}'  # em paralelo
palco recruit "Coruja" --preset "Codex" --role "Revisor"
palco note create "## Plano" --name "Plano"
palco portal create "App" "localhost:3000" && palco portal snapshot "App"
palco floor create "Experimento" --branch feat/ideia
palco routine create "Pulso" --every 1h --prompt --command "rode os testes e resuma" --target "Revisor"
```

`palco help` lista tudo. A skill instalada ensina o Claude Code e o Codex a usar esses comandos.

## Segurança

O serviço escuta só em `127.0.0.1`. Toda chamada exige o token de `~/.palco/config.json` (arquivo `0600`), e o servidor recusa `Host` e `Origin` que não sejam locais, o que bloqueia páginas abertas no seu navegador e ataques de DNS rebinding. Mesmo assim, quem tem o token roda comandos como você: não compartilhe a URL com `#token=`.

Na primeira vez que um terminal do Palco abrir uma pasta em `~/Documents` ou `~/Desktop`, o macOS pode pedir permissão para o `node`. Aceite uma vez.

## Desenvolvimento

```bash
npm install
npm run build        # servidor + interface
npm test             # testes de integração (PTY real, git, Chrome headless)
npm run typecheck
npm run dev:server   # servidor com reload (porta 4747)
npm run dev:web      # Vite em 5747 com proxy para o servidor
```

Estrutura: `server/` (HTTP, WebSocket, sessões PTY, protocolo dos agentes, andares, routines, portais), `cli/` (comando `palco`), `web/` (React + React Flow + xterm.js), `skills/` (skill dos agentes), `scripts/install.sh`.

## Licença

MIT. O Palco é uma implementação independente inspirada em ferramentas de canvas para agentes; não contém código nem recursos de outros produtos.
