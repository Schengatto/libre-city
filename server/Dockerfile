# Server multigiocatore di Libre City. Immagine minima Node su Alpine.
# Funziona su Fly.io, Railway, Render e qualsiasi host che accetti un container.
FROM node:22-alpine

WORKDIR /app

# prima le sole dipendenze: sfrutta la cache dei layer
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# poi il codice
COPY index.js ./

# la piattaforma inietta PORT; in locale il server ripiega su 8787
ENV PORT=8080
EXPOSE 8080

CMD ["node", "index.js"]
