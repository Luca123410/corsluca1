const axios = require("axios");
const cheerio = require("cheerio");

const API_URL = "https://apibay.org/q.php";
const BASE_1337X = "https://1337x.to"; // Alternative: 1337x.st, 1337x.ws, x1337x.se

// Lista tracker aggiornata e performante
const TRACKERS = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.tracker.cl:1337/announce",
    "udp://9.rarbg.com:2810/announce",
    "udp://tracker.openbittorrent.com:80/announce",
    "udp://opentracker.i2p.rocks:6969/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://open.stealth.si:80/announce",
    "udp://vibe.community:6969/announce",
    "https://opentracker.i2p.rocks:443/announce",
    "udp://tracker.tiny-vps.com:6969/announce"
];

// Regex consolidata per intercettare tutto ciò che è italiano
const ITA_REGEX = /\b(ITA|ITALIAN|ITALIANO|MULTI|DUAL|MD|SUB[\s._-]?ITA|FORCED|AC3[\s._-]?ITA|DTS[\s._-]?ITA|CINEFILE|NOVARIP|MEM|ROBBYRS|IDN_CREW|PSO|BADASS)\b/i;

function cleanString(str) {
    return str
        .replace(/[:"'’]/g, "")
        .replace(/[^a-zA-Z0-9\s\-.\[\]]/g, " ") // Mantiene le parentesi quadre che spesso contengono info
        .replace(/\s+/g, " ")
        .trim();
}

function buildMagnet(hash, name) {
    let magnet = `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}`;
    TRACKERS.forEach(tr => magnet += `&tr=${encodeURIComponent(tr)}`);
    return magnet;
}

// Timeout per evitare che l'addon si blocchi
const TIMEOUT_MS = 8000; 
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";

/* ===========================================================
   🔵 TPB SEARCH (OTTIMIZZATO)
   Invece di 15 richieste, ne facciamo 2 o 3 strategiche.
   =========================================================== */
async function searchTPB(title, year) {
    try {
        const cleanTitle = cleanString(title);
        
        // Strategia: 
        // 1. Cerca "Titolo ITA" (Molto specifico)
        // 2. Cerca "Titolo" (Generico) -> Filtriamo noi i risultati ITA dopo
        // Questo riduce le chiamate da 15 a 2.
        const queries = [
            `${cleanTitle} ITA`,
            cleanTitle
        ];

        if (year) queries[0] += ` ${year}`; // Raffina la prima query

        const uniqueResults = new Map();

        const requests = queries.map(q => 
            axios.get(API_URL, {
                params: { q, cat: 200 }, // Cat 200 = Video
                timeout: TIMEOUT_MS
            }).catch(() => ({ data: [] }))
        );

        const responses = await Promise.all(requests);

        for (const res of responses) {
            const data = res.data;
            if (!Array.isArray(data) || !data.length || data[0].name === "No results returned") continue;

            for (const item of data) {
                // Filtro HASH nullo
                if (!item.info_hash || item.info_hash === "0000000000000000000000000000000000000000") continue;

                const name = item.name;
                
                // 🔥 FILTRO LOCALE: Controlliamo qui se è ITA. Molto più veloce che chiedere all'API.
                if (!ITA_REGEX.test(name)) continue;

                // Filtro Anno (Tolleranza +/- 1 anno)
                if (year) {
                    const y = parseInt(year);
                    if (!name.includes(y.toString()) && !name.includes((y - 1).toString()) && !name.includes((y + 1).toString())) {
                        // Se l'anno non è nel titolo, accettalo comunque se la query era specifica, altrimenti scarta
                        // Qui siamo permissivi per non perdere risultati
                    }
                }

                const hash = item.info_hash.toUpperCase();
                const seeders = parseInt(item.seeders || 0);
                const sizeBytes = parseInt(item.size || 0);

                // Deduplica: mantieni quello con più seeders se l'hash è identico (raro su TPB, ma buona norma)
                if (!uniqueResults.has(hash)) {
                    uniqueResults.set(hash, {
                        title: name,
                        magnet: buildMagnet(hash, name),
                        size: (sizeBytes / 1073741824).toFixed(2) + " GB",
                        sizeBytes,
                        seeders,
                        source: "Apibay"
                    });
                }
            }
        }

        return [...uniqueResults.values()];
    } catch (e) {
        console.error("TPB Error:", e.message);
        return [];
    }
}

/* ===========================================================
   🔵 1337x SEARCH (OTTIMIZZATO)
   =========================================================== */
async function search1337x(title, year) {
    const cleanTitle = cleanString(title);
    
    // 1337x ha un motore di ricerca decente. Basta cercare "Titolo ITA".
    // Se cerchiamo troppe varianti, veniamo bloccati da Cloudflare.
    const query = `${cleanTitle} ITA`; 
    const candidates = new Map();

    const headers = { "User-Agent": USER_AGENT };

    try {
        // Fase 1: Ricerca nella categoria Film (Movies)
        const url = `${BASE_1337X}/category-search/${encodeURIComponent(query)}/Movies/1/`;
        const { data } = await axios.get(url, { timeout: TIMEOUT_MS, headers }).catch(() => ({ data: "" }));

        if (!data) return [];

        const $ = cheerio.load(data);

        $("table.table-list tbody tr").each((_, row) => {
            const tds = $(row).find("td");
            const nameLink = tds.eq(0).find("a").eq(1);
            if (!nameLink.length) return;

            const name = nameLink.text().trim();
            const torrentPath = nameLink.attr("href");
            
            // Verifica Regex anche qui per sicurezza
            if (!ITA_REGEX.test(name) || !torrentPath) return;

            if (year) {
                const y = parseInt(year);
                // Controllo anno semplice
                if (!name.includes(y.toString()) && !name.includes((y-1).toString()) && !name.includes((y+1).toString())) return;
            }

            const seeders = parseInt(tds.eq(1).text().replace(/,/g, "")) || 0;
            
            // Parsing dimensione
            const sizeText = tds.eq(4).text(); // Di solito è nella 5a colonna (indice 4)
            let sizeBytes = 0;
            if (sizeText.includes("GB")) sizeBytes = parseFloat(sizeText) * 1073741824;
            else if (sizeText.includes("MB")) sizeBytes = parseFloat(sizeText) * 1048576;

            candidates.set(torrentPath, {
                name,
                path: torrentPath,
                seeders,
                sizeBytes,
                size: sizeText
            });
        });

        // Fase 2: Prendi i magnet link SOLO dei primi 5 risultati migliori (per risparmiare tempo e richieste)
        const topCandidates = [...candidates.values()]
            .sort((a, b) => b.seeders - a.seeders)
            .slice(0, 5); // Limite a 5 richieste di pagina dettaglio

        const magnets = await Promise.all(topCandidates.map(async c => {
            try {
                const detailUrl = BASE_1337X + c.path;
                const { data: detailData } = await axios.get(detailUrl, { timeout: TIMEOUT_MS, headers });
                const $$ = cheerio.load(detailData);
                
                // Cerca il magnet link
                const magnet = $$("a[href^='magnet:']").first().attr("href");
                if (!magnet) return null;

                // Estrai Hash pulito
                const m = magnet.match(/btih:([A-F0-9]{40})/i);
                const hash = m ? m[1].toUpperCase() : null;
                if (!hash) return null;

                return {
                    title: c.name,
                    magnet: buildMagnet(hash, c.name), // Ricostruisce il magnet con i nostri tracker veloci
                    size: c.size,
                    sizeBytes: c.sizeBytes,
                    seeders: c.seeders,
                    source: "1337x"
                };
            } catch (e) {
                return null;
            }
        }));

        return magnets.filter(Boolean);

    } catch (e) {
        console.error("1337x Error:", e.message);
        return [];
    }
}

/* ===========================================================
   🔴 UNIFICA TUTTO E ESPORTA
   =========================================================== */
async function searchMagnet(title, year) {
    console.log(`\n🔍 [APIBAY + 1337x] Searching: ${title} (${year})`);

    // Esegui le ricerche in parallelo
    const [tpbResults, xResults] = await Promise.all([
        searchTPB(title, year),
        search1337x(title, year)
    ]);

    // Unione e Deduplicazione per Hash
    const uniqueMap = new Map();

    const addResult = (item) => {
        const match = item.magnet.match(/btih:([A-F0-9]{40})/i);
        if (match) {
            const hash = match[1].toUpperCase();
            // Se esiste già, sovrascrivi solo se ha più seeders
            if (!uniqueMap.has(hash) || item.seeders > uniqueMap.get(hash).seeders) {
                uniqueMap.set(hash, item);
            }
        }
    };

    tpbResults.forEach(addResult);
    xResults.forEach(addResult);

    const results = [...uniqueMap.values()];

    // Ordinamento finale: Prima per Seeders, poi per dimensione
    results.sort((a, b) => b.seeders - a.seeders || b.sizeBytes - a.sizeBytes);

    console.log(`✅ TPB: ${tpbResults.length} | 1337x: ${xResults.length} -> Totale Unici: ${results.length}`);

    // Ritorna fino a 15 risultati migliori (6 erano pochi per una "Bomba")
    return results.slice(0, 15);
}

module.exports = { searchMagnet };
