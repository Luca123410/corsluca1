/**
 * Modulo 'debridx.js': Implementazione reale (simulata) per l'API Torbox.
 * * Obiettivo: Fornire la funzione getStreamLink(token, magnet) compatibile con addon.js.
 * * La logica Torbox richiede 3 passaggi:
 * 1. Estrai l'infoHash dal magnet.
 * 2. Controlla la cache per l'infoHash.
 * 3. Se cached, aggiungi il magnet/torrent e ottieni il link diretto.
 */

const axios = require("axios"); // Usiamo axios per coerenza con l'ambiente Node.js standard
const API_BASE_URL = 'https://api.torbox.app/v1/api';

/**
 * Estrae l'infoHash da un magnet link.
 * @param {string} magnetLink - Il magnet link.
 * @returns {string|null} L'infoHash (40 caratteri) o null.
 */
function extractInfoHash(magnetLink) {
    const match = magnetLink.match(/btih:([a-fA-F0-9]{40})/);
    return match ? match[1].toLowerCase() : null;
}

/**
 * Ottiene il link di streaming pronto da Torbox per un dato magnet.
 * @param {string} token - Il token API di Torbox.
 * @param {string} magnet - Il magnet link da verificare.
 * @returns {object|null} {url: string, filename: string, size: number, type: 'ready'} o null.
 */
async function getStreamLink(token, magnet) {
    if (!token) return null;

    const infoHash = extractInfoHash(magnet);
    if (!infoHash) return null;

    try {
        // --- 1. CHECK CACHE (Verifica disponibilità istantanea) ---
        const cacheRes = await axios.post(`${API_BASE_URL}/torrents/checkcached`, {
            hashes: [infoHash],
            format: 'object',
            list_files: true
        }, {
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
        });

        const cacheData = cacheRes.data;
        const cachedInfo = cacheData.success && cacheData.data ? cacheData.data[infoHash] : null;

        if (!cachedInfo) {
            // Non è in cache, restituisci null subito.
            return null;
        }

        // --- 2. AGGIUNGI TORRENT (Necessario per accedere ai file sbloccati) ---
        // Aggiungiamo il magnet; se è cached, l'operazione è quasi istantanea.
        const addRes = await axios.post(`${API_BASE_URL}/torrents/createtorrent`, {
            magnet: magnet
        }, {
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
        });
        
        if (!addRes.data.success || !addRes.data.data) {
             throw new Error("Failed to add cached magnet to Torbox list.");
        }
        
        const torrentId = addRes.data.data.id;
        const torrentFiles = cachedInfo.files || [];
        
        // --- 3. SELEZIONA IL FILE PIÙ GRANDE E GENERA IL LINK ---
        const mainFile = torrentFiles.sort((a, b) => b.size - a.size)[0];
        
        if (!mainFile) {
            console.error("Torbox: Cached torrent found but no files listed.");
            return null;
        }
        
        // Torbox fornisce un link diretto con il file_id e torrent_id
        // Il link di streaming diretto (m3u8 o mp4) viene generato con /torrents/geturl
        const streamUrlRes = await axios.post(`${API_BASE_URL}/torrents/geturl`, {
            torrent_id: torrentId,
            file_id: mainFile.id,
            url_type: 'download' // 'download' dovrebbe dare un link diretto
        }, {
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
        });
        
        if (!streamUrlRes.data.success || !streamUrlRes.data.data || !streamUrlRes.data.data.url) {
            throw new Error("Failed to generate stream URL from Torbox.");
        }
        
        // Pulizia finale (Opzionale: puoi lasciare il torrent nell'account per un po')
        // axios.delete(`${API_BASE_URL}/torrents/delete/${torrentId}`, { headers: { 'Authorization': `Bearer ${token}` } }).catch(() => {});

        return {
            url: streamUrlRes.data.data.url,
            filename: mainFile.name,
            size: mainFile.size,
            type: 'ready'
        };

    } catch (error) {
        console.error("Torbox (DebridX) Error:", error.message);
        return null;
    }
}

module.exports = {
    getStreamLink
};
