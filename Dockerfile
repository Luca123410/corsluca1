# Usa un'immagine Node leggera
FROM node:18-alpine

# Imposta la directory di lavoro
WORKDIR /app

# Copia i file di dipendenza
COPY package*.json ./

# Installa le dipendenze
RUN npm install --production

# Copia il resto del codice (addon.js, rd.js, corsaro.js, public/)
COPY . .

# Espone la porta usata dall'addon
EXPOSE 7000

# Comando di avvio
CMD ["npm", "start"]
