# Server multigiocatore di Libre City. Immagine minima Node su Alpine.
# Funziona su Fly.io, Railway, Render e qualsiasi host che accetti un container.
FROM node:22-alpine

WORKDIR /app

# prima le sole dipendenze: sfrutta la cache dei layer
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# poi il codice: il server + l'harness della simulazione autoritativa (Fase 2) e i
# sorgenti della sim (staging in sim/, preparati da deploy-vps.sh copiando js/*.js)
COPY index.js sim-runtime.js ./
COPY sim ./sim

# la piattaforma inietta PORT; in locale il server ripiega su 8787
ENV PORT=8080
EXPOSE 8080

CMD ["node", "index.js"]
