# Server multigiocatore di Vibe City. Immagine minima Node su Alpine.
# Funziona su Fly.io, Railway, Render e qualsiasi host che accetti un container.
FROM node:22-alpine

WORKDIR /app

# prima le sole dipendenze: sfrutta la cache dei layer
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# poi il codice: il server + l'harness della simulazione autoritativa (Fase 2) e i
# sorgenti della sim (staging in sim/, preparati da deploy-vps.sh copiando js/*.js)
COPY index.js sim-runtime.js leaderboard.js ./
COPY sim ./sim

# classifica condivisa: dati di runtime, montati da un volume (vedi docker-compose.yml).
# La cartella esiste già nell'immagine così il primo avvio scrive senza inciampi.
RUN mkdir -p /app/data

# la piattaforma inietta PORT; in locale il server ripiega su 8787
ENV PORT=8080
EXPOSE 8080

CMD ["node", "index.js"]
