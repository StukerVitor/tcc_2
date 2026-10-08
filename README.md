# LASCAS

## O que você precisa

Antes de tudo, garanta que a máquina tenha:

- **Node.js + npm**
- **Ollama** instalado e disponível no terminal
- **Google Chrome** ou **Chromium**
- **bash**
- permissão de **`sudo`** (o script pode usar `sudo` para subir/parar o Ollama e liberar a porta)

## Como rodar

Dê permissão ao script na primeira vez:

```bash
chmod +x lascas.sh
```

Depois inicie tudo com:

```bash
./lascas.sh start
```

Esse comando já faz o necessário:

- sobe o **Ollama** se ele não estiver rodando
- cria/atualiza o modelo **`legal-simplifier:latest`**
- roda **`npm install`** automaticamente onde faltar `node_modules`
- sobe a API local em **`http://127.0.0.1:5179`**
- inicia o build em modo watch da extensão em **`lascas-extension/dist`**

## Como carregar a extensão

Depois do `./lascas.sh start`:

1. abra **`chrome://extensions`**
2. ative **Modo do desenvolvedor**
3. clique em **Carregar sem compactação**
4. selecione a pasta:

```text
lascas-extension/dist
```

Se alterar algo na extensão e o watch recompilar, clique em **Reload** na extensão para atualizar no navegador.

### Para usar PDF local (`file://`)

Se quiser usar a extensão em PDFs abertos do disco, ative também:

- **Allow access to file URLs** / **Permitir acesso a URLs de arquivo**

## Comandos do script

Subir tudo:

```bash
./lascas.sh start
```

Parar tudo:

```bash
./lascas.sh stop
```

Reiniciar:

```bash
./lascas.sh restart
```

Ver status:

```bash
./lascas.sh status
```

Ver logs:

```bash
./lascas.sh logs
```

## Como validar se subiu certo

Confira o health check:

```bash
curl http://127.0.0.1:5179/health
```

Resposta esperada:

```json
{ "ok": true }
```

## Portas e endereços usados

- API local: **`127.0.0.1:5179`**
- Ollama: **`127.0.0.1:11434`**

A extensão conversa com a API local em `localhost:5179`.
