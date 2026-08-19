---
name: release
description: Corta e publica uma versão do Arco seguindo docs/RELEASE.md — leva o trabalho para main, fecha o changelog, atualiza o What's new, verifica, bumpa, publica os instaladores e confirma que o apt recebeu. Use quando o dono autorizar uma release, disser "sobe uma versão", "publica", "release nova", ou pedir para atualizar via apt.
allowed-tools: Bash, Read, Edit, Write, Grep, Glob
argument-hint: "[patch|minor|major|X.Y.Z]"
---

# Release do Arco

Executa [`docs/RELEASE.md`](../../../docs/RELEASE.md). Leia o runbook antes: ele
diz **por que** cada passo existe, e todo passo aqui existe porque a falta dele
já chegou na máquina de alguém.

**A release é decisão do dono.** Só rode com autorização explícita para esta
release. Bump padrão é `patch`; use `minor` quando entrou feature.

## 1. `main` contém tudo

```bash
git -C <repo> status --short          # tem que estar limpo
git rev-list --count origin/main..<branch>   # o que falta subir
git -C <repo> merge --ff-only <branch> && git -C <repo> push origin main
```

Release cortada de branch deixa a `main` atrás do que está instalado, e a
próxima versão sai com número **menor** que a da máquina do dono. Já aconteceu
entre 2.1.1 e 2.2.0.

Confira também que ninguém publicou por fora:

```bash
gh release list --limit 3
dpkg-query -W -f='${Version}\n' arco
```

Se a versão instalada for maior que a da `main`, **pare** e reconcilie antes.

## 2. Changelog fechado

`docs/CHANGELOG.md`: transforme `## [Unreleased]` em `## [X.Y.Z] — AAAA-MM-DD`
e deixe um `[Unreleased]` vazio no topo. Nada pode sobrar dentro dele.

## 3. What's new atualizado

O diálogo que o dono lê **não** é o changelog:

1. `src/lib/changelogData.ts` — entrada no topo de `CHANGELOG_RELEASES`.
2. `src/lib/i18n/messages/en.ts` e `pt-BR.ts` — chaves `whatsNew.vXYZ.noteN`.

Escreva para quem não leu o código: o que mudou e o que ele precisa fazer
(reinstalar o comando de terminal, criar um token, ligar uma preferência).

## 4. Verificação

```bash
npm run build   # tsc + i18n + vite
npm test        # inclui o guard do What's new
```

Mudança visível: rode o app e olhe. Screenshot vale mais que dedução.

## 5. Cortar

```bash
npm run release $1
```

O script recusa se faltar seção no changelog, entrada no What's new, ou se
sobrou conteúdo em `[Unreleased]`. Recusa é o gate funcionando — corrija, não
contorne.

## 6. Publicar

O push da tag no passo anterior já disparou o workflow. Acompanhe:

```bash
gh run watch
```

`npm run release:publish` existe para re-disparar uma publicação que falhou no
meio — não é parte do caminho normal.

Linux publica primeiro e libera o apt; Windows e macOS se anexam depois, cada um
quando termina. Não espere a matriz inteira para dar a release por feita.

## 7. Confirmar

```bash
gh run view <id> --json status,jobs --jq '.status, (.jobs[] | {name, conclusion})'
gh release view v<versao> --json assets --jq '.assets[].name'
curl -s https://devmatheusmota.github.io/arco/dists/stable/main/binary-amd64/Packages | head -4
```

O índice do apt tem que responder a versão nova. Só então diga que está pronto,
e diga também o comando que ele roda:

```
sudo apt update && sudo apt upgrade
```

Se a release mexeu na linha de comando, avise: o `.deb` **não** atualiza o atalho
`arco` em `~/.local/bin` — ele é reinstalado em Preferências → Integrações →
Comando de terminal.

## Ao terminar

Uma linha por item: versão publicada, o que entrou, o que o dono precisa fazer,
e o que ficou para trás (plataforma que falhou, job na fila). Não diga "pronto"
enquanto o apt não responder a versão nova.
