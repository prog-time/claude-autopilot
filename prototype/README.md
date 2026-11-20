# Claude Autopilot

Фоновый конвейер для ваших open source проектов. Пока вы работаете, Claude Code сам разбирает GitHub Issues, делает задачи по вашему git-flow, вливает их в `develop` и предлагает новые доработки. Вам остаются два решения: **подтвердить идеи** и **смержить develop → main**.

## Кто что делает

| Claude (через autopilot) | Вы |
|---|---|
| Раз в N минут проверяет открытые Issues во всех ваших репозиториях | Одобряете идеи (можно поправить текст) или отклоняете их |
| Выполняет задачу вашей командой `/task_complete` (ветка `issues-N`, team-lead, `/task_submit`, PR → `develop`) | Открываете и мержите PR develop → main |
| Ждёт CI. Если CI красный или есть конфликт, Claude чинит сам (до `maxCiFixAttempts` раз) | Нажимаете «Выпустить (git-release)» после мержа в main |
| На зелёном CI делает squash-merge в `develop` (это делает приложение, не Claude) | При необходимости отвечаете на вопросы Claude и разрешаете нестандартные команды |
| Когда в репозитории нет работы, анализирует проект и предлагает исправления ошибок и новый функционал | |
| После одобрения идеи создаёт issue через `/task_create`, и тот сразу попадает в очередь | |

```
           ┌──────── идея ──▶ [вы: одобрить] ──▶ /task_create ──┐
 Claude ───┤                                                    ▼
 анализ    │                                              GitHub Issue
           └────────────────────────────────────────────────────┤ sync
                                                                ▼
                         /task_complete → issues-N → PR → develop
                                                                │ CI ✗ → Claude чинит
                                                                │ CI ✓ → squash-merge
                                                                ▼
                               develop ──▶ [вы: PR develop → main] ──▶ git-release
```

## Ваши правила из ~/.claude соблюдаются

Autopilot запускает Claude через Agent SDK с `settingSources: ['user', 'project', 'local']`, то есть так же, как обычный Claude Code. Поэтому подхватываются:
- `~/.claude/CLAUDE.md`: секреты, `git add` только по файлам, без force push и так далее;
- команды `~/.claude/commands/task_*.md`, скиллы (`team-lead`, `git-commit`, `git-pr`, `git-release`, `issue-templates`) и агенты;
- хуки из `~/.claude/settings.json`: `pr-base-guard.py` не даст открыть PR не в `develop`, `rules_check.py` тоже работает.

Autopilot не дублирует ваш процесс, он вызывает ваши команды:

| Шаг | Что запускается |
|---|---|
| Выполнить issue | `/task_complete <issue url>` |
| Починить CI или конфликт | продолжение той же сессии: `/task_branch <url>`, исправление, `/task_submit` |
| Создать задачу из идеи | `/task_create <заголовок + описание>` |
| Релиз | скилл `git-release` (только по вашей кнопке) |

Сверх ваших правил autopilot делает только одно: **мержит PR issues-N → develop** (squash, после зелёного CI). Это следует из того, что вы подтверждаете только develop → main. Если хотите смотреть каждый PR, поставьте `"autoMergeToDevelop": false`.

## Отдельный клон, ваши папки не трогаются

`/task_branch` требует чистого дерева и переключает ветки. Поэтому Claude работает в собственном клоне каждого репозитория: `~/.claude-autopilot/repos/owner__repo`. Пока вы работаете в `~/code/<проект>`, Claude не трогает ваши ветки и незакоммиченные изменения.
- В клоне `tasks/` и `github-tasks.json` добавлены в `.git/info/exclude`, чтобы `/task_branch` не останавливался на «грязном» дереве. Файлы задач, которые создают `/task_create`, остаются в клоне.
- Неотслеживаемые настройки проекта `.claude/` (например, `settings.local.json`) копируются из вашей локальной папки.
- Параллельные задачи одного проекта работают в отдельных клонах (см. «Многопоточность»).

## Многопоточность

Несколько проектов работают одновременно. Каждая задача запускается в своей сессии Claude (отдельный процесс) и в своей папке-клоне, поэтому задачи друг другу не мешают.

| Настройка | По умолчанию | Что задаёт |
|---|---|---|
| `concurrency` | 4 | сколько сессий Claude работает одновременно по всем проектам |
| `perRepoConcurrency` | 1 | сколько задач **одного** проекта выполняется параллельно |
| `ioConcurrency` | 6 | сколько проектов опрашивается в GitHub одновременно |

- Оба лимита задач меняются на лету в шапке панели (кнопки − / +), без перезапуска. Значения сохраняются.
- При `perRepoConcurrency > 1` для проекта создаются дополнительные клоны: `owner__repo@1`, `owner__repo@2`… Ваш `/task_branch` переключает ветки и требует чистого дерева, поэтому две задачи не могут работать в одной папке.
- Продолжение сессии (автоисправление CI, ваше указание) выполняется в том же клоне, где задача начиналась.
- Если все клоны проекта заняты, планировщик берёт задачу из другого проекта, и потоки не простаивают.
- Под шапкой есть полоса потоков: что сейчас делает каждый, прогресс плана, кто ждёт вашего ответа. Клик по карточке открывает ленту задания.
- Опрос GitHub и проверка CI во всех PR тоже идут параллельно.

Чем больше потоков, тем быстрее расходуются лимиты подписки или API. Задача, ждущая вашего ответа, держит свой поток, пока вы не ответите.

## Какие issues берутся в работу

Берутся все открытые issues, кроме:
- issues с метками из `issues.skipLabels` (`question`, `wontfix`, `claude:skip`…);
- issues, у которых уже есть PR из `issues-N`: открытый PR autopilot ведёт до мержа, смерженный в `develop` помечается «В develop».

Если задать `issues.onlyLabels`, будут браться только issues с этими метками.

Issue остаётся открытым, пока изменения в `develop`: так требует ваш процесс, его закрывает `git-release`. В панели такие задачи видны на вкладке «В develop».

## Установка (macOS)

Нужно:
- Node.js 20+;
- Claude Code, в котором вы залогинены (или `ANTHROPIC_API_KEY`);
- `gh` после `gh auth login`;
- ветка `develop` во всех репозиториях.

```bash
cd claude-autopilot
npm install @anthropic-ai/claude-agent-sdk@latest
cp config.example.json config.json
npm start        # http://localhost:4777  (запускается с nice -n 10)
```

Убедитесь, что хуки из `claude-config` зарегистрированы в `~/.claude/settings.json` (см. `hooks/README.md`). Autopilot полагается на `pr-base-guard` как на жёсткий стоп.

## config.json

| Поле | Что задаёт |
|---|---|
| `scan.dirs`, `scan.owners` | где искать локальные проекты и чьи (по `origin` на github.com) |
| `scan.exclude`, `repos[]` | исключения и явный список (`repo`, `localPath`) |
| `pollIntervalMinutes` | как часто проверять GitHub |
| `concurrency`, `perRepoConcurrency`, `ioConcurrency` | многопоточность, см. раздел выше |
| `issues.skipLabels` / `onlyLabels` | какие issues брать |
| `autoMergeToDevelop`, `maxCiFixAttempts` | автомерж в develop и число попыток автоисправления CI |
| `proposals.*` | идеи: включены ли, раз в сколько часов, сколько держать неразобранными, сколько предлагать за раз |
| `permissions.autoAllowBashPrefixes` | команды, которые Claude выполняет сам (git, gh, тесты, линтеры) |
| `permissions.alwaysAskBashPatterns` | подстроки, при которых всегда спрашивается подтверждение (`--force`, `--no-verify`, `gh pr merge`, `git tag`, `rm -rf`…) |

Генерация идей идёт в режиме «только чтение»: любые изменения и вопросы автоматически запрещаются.

## Панель

- **Слева** список заданий («В работе», «В develop», «Все») и репозитории с кнопкой «💡 Идеи».
- **По центру** выбранное задание: план Claude (TodoWrite) с прогрессом, живая лента действий, включая сабагентов team-lead, статус CI, PR, стоимость, поле «Указание для Claude».
- **Справа**, в разделе «Ваши решения»:
  - Claude ждёт ответа: вопросы и нестандартные команды;
  - Релизы: что в develop и не в main, кнопки «PR develop → main» и «Выпустить (git-release)»;
  - Идеи на подтверждение: текст можно отредактировать перед созданием задачи;
  - Проблемы: Claude остановился без PR, CI не чинится, задание упало.

Когда нужно ваше решение, приходит уведомление macOS. Пока Claude работает, Mac не засыпает (`caffeinate`).

## Автозапуск

`~/Library/LaunchAgents/com.prog-time.claude-autopilot.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.prog-time.claude-autopilot</string>
  <key>ProgramArguments</key><array>
    <string>/bin/zsh</string><string>-lc</string>
    <string>cd ~/code/claude-autopilot &amp;&amp; npm start</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/claude-autopilot.log</string>
  <key>StandardErrorPath</key><string>/tmp/claude-autopilot.log</string>
</dict></plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.prog-time.claude-autopilot.plist
```

## Безопасность

- Сервер слушает только `127.0.0.1`.
- Force push, `--no-verify`, `git tag`, `gh pr merge`, push в `main` или `develop` от имени Claude всегда требуют вашего подтверждения.
- В `main` пишут только люди: это обеспечивают и autopilot, и ваш хук `pr-base-guard`.

## Структура

```
src/pipeline.js  синхронизация issues, очередь, CI и автомерж, идеи, релизы
src/runner.js    Claude Agent SDK, canUseTool → решения человека, журнал
src/repos.js     поиск проектов, рабочие клоны, информация о релизе
src/github.js    gh CLI
src/store.js     состояние (~/.claude-autopilot/state.json) и журналы
src/server.js    API + SSE
public/          веб-интерфейс
```
