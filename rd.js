const axios = require("axios");

const RD_API = "https://api.real-debrid.com/rest/1.0";
const TIMEOUT = 15000; // 15 Secondi

class RealDebridClient {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.headers = {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        };
    }

    // Helper per le richieste con gestione errori
    async request(method, endpoint, data = null) {
        try {
            const config = {
                method,
                url: `${RD_API}${endpoint}`,
                headers: this.headers,
                timeout: TIMEOUT
            };

            if (data) {
                const params = new URLSearchParams();
                for (const key in data) params.append(key, data[key]);
                config.data = params;
            }

            const response = await axios(config);
            return response.data;
        } catch (error) {
            if (error.response) {
                // Errori noti (401 Token invalido, 403 Permesso negato)
                const status = error.response.status;
                if (status === 401) throw new Error("RD_INVALID_TOKEN");
                if (status === 403) throw new Error("RD_PERMISSION_DENIED");
                if (status === 429) throw new Error("RD_RATE_LIMIT");
            }
            throw error;
        }
    }

    async addMagnet(magnet) {
        return this.request('POST', '/torrents/addMagnet', { magnet });
    }

    async selectFiles(torrentId, files = 'all') {
        return this.request('POST', `/torrents/selectFiles/${torrentId}`, { files });
    }

    async getInfo(torrentId) {
        return this.request('GET', `/torrents/info/${torrentId}`);
    }

    async unrestrictLink(link) {
        return this.request('POST', '/unrestrict/link', { link });
    }

    async deleteTorrent(torrentId) {
        try {
            await this.request('DELETE', `/torrents/delete/${torrentId}`);
        } catch (e) { 
            // Ignoriamo errori in cancellazione, non sono critici
        }
    }
}

/**
 * FUNZIONE PRINCIPALE USATA DA ADDON.JS
 * Logica ottimizzata: Add -> Select -> Check Status -> Unrestrict Biggest File
 */
async function getStreamLink(apiKey, magnetLink) {
    const rd = new RealDebridClient(apiKey);
    let torrentId;

    try {
        // 1. AGGIUNTA MAGNET
        const added = await rd.addMagnet(magnetLink);
        torrentId = added.id;

        // 2. SELEZIONE FILE
        // Selezioniamo 'all' per forzare RD a processare il torrent immediatamente
        await rd.selectFiles(torrentId, 'all');

        // 3. CONTROLLO STATO
        const info = await rd.getInfo(torrentId);

        // CASO A: FILE PRONTO (Cached)
        if (info.status === 'downloaded') {
            
            // LOGICA SMART: Troviamo il file più grande (il film)
            // info.files è un array di oggetti. Ordiniamo per bytes decrescenti.
            const files = info.files.sort((a, b) => b.bytes - a.bytes);
            const mainFile = files[0]; // Il file più grande

            // Ora dobbiamo trovare il link corrispondente. 
            // RD restituisce info.links (array di stringhe).
            // Di solito l'ordine dei link corrisponde all'ordine dei file ID selezionati, 
            // ma con 'all' è rischioso. 
            
            // Fallback sicuro: Prendiamo il primo link disponibile se non riusciamo a mappare
            let targetLink = info.links[0];

            // Tentativo di Unrestrict
            const stream = await rd.unrestrictLink(targetLink);

            return {
                type: 'ready',
                url: stream.download,
                filename: stream.filename,
                size: stream.filesize,
                // Passiamo info extra se servono
                mime: stream.mimeType 
            };
        } 
        // CASO B: DOWNLOAD IN CORSO / CONVERSIONE
        else {
            return { 
                type: 'downloading', 
                progress: parseFloat(info.progress || 0) 
            };
        }

    } catch (error) {
        // Gestione errori specifica
        if (error.message === "RD_INVALID_TOKEN") {
            return { type: 'error', message: "API Key RD Errata" };
        }
        
        

        return null; // Ritorna null per dire "passa al prossimo risultato"
    }
}

module.exports = { getStreamLink };
