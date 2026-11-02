# Par ou Ímpar online

Jogo multiplayer: entre na sala com um nome, desafie outro jogador, cara ou coroa, melhor de 3, revanche melhor de 5 e de 7.
Não tem dependências: só precisa do Node 18 ou mais novo.

## Rodar no seu computador
```
npm start
```
Abra http://localhost:3000. Para jogar pelo celular na mesma rede Wi-Fi, use o IP do computador, por exemplo http://192.168.0.10:3000.

## Publicar na internet (Render, grátis)
1. Suba esta pasta para um repositório no GitHub.
2. No Render: **New → Web Service** e escolha o repositório.
3. Runtime **Node**, Build Command `npm install`, Start Command `npm start`.
4. Quando terminar, o Render dá um link `https://...onrender.com`. Mande para quem quiser jogar.

No plano grátis o Render "dorme" após alguns minutos sem uso, e o primeiro acesso leva cerca de 1 minuto. Railway e Fly.io funcionam do mesmo jeito (o servidor usa a variável `PORT`).

## Como funciona
- `server.js`: servidor HTTP + WebSocket (em `/ws`) que guarda a sala e toda a lógica do jogo.
- `public/index.html`: a tela do jogo.
- Se a conexão cair (por exemplo, celular bloqueado), o jogo reconecta sozinho e a pessoa tem 20 segundos para voltar sem perder a partida.
