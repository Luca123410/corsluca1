const axios = require("axios");
const cheerio = require("cheerio");

const API_URL = "https://apibay.org/q.php";
const BASE_1337X = "https://1337x.to";

const TRACKERS = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.tracker.cl:1337/announce",
    "udp://tracker.openbittorrent.com:80/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.ds.is:6969/announce",
    "udp://retracker.lanta-net.ru:2710/announce",
    "udp://tracker.moeking.me:6969/announce",
    "udp://ipv4.tracker.harry.lu:80/announce"
];

const ITA_REGEX = /(ITA|ITALIAN|ITALIANO|MULTI|DUAL|MD|SUB.?ITA|FORCED|AC3.?ITA|DTS.?ITA|CINEFILE|NOVA?RIP|MEM|ROBBYRS|IDN_CREW|PSO|BADASS)/i;

function cleanString(str) {
    return str
        .replace(/[:"'’]/g, "")
        .replace(/[^a-zA-Z0-9\s\-.\[\]]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function buildMagnet(hash, name) {
    let magnet = `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}`;
    TRACKERS.forEach(tr => magnet += `&tr=${encodeURIComponent(tr)}`);
    return magnet;
}

/* ===========================================================
   🔵 TPB SEARCH
   =========================================================== */
async function searchTPB(title, year) {
    try {
        const cleanTitle = cleanString(title);
        let baseQuery = cleanTitle + (year ? ` ${year}` : "");

        const italianKeywords = [
            "ITA", "Italian", "Italiano", "sub ita", "AC3 ITA",
            "DTS ITA", "MULTI", "DUAL", "MD", "FORCED ITA"
        ];

        const queries = [
            baseQuery,
            ...italianKeywords.map(k => `${baseQuery} ${k}`)
        ].slice(0, 15);

        const requests = queries.map(q =>
            axios.get(API_URL, {
                params: { q, cat: 200 },
                timeout: 10000
            }).catch(() => ({ data: [] }))
        );

        const responses = await Promise.all(requests);
        const resultsMap = new Map();

        for (const res of responses) {
            const data = res.data;
            if (!Array.isArray(data) || !data.length || data[0].name === "No results returned") continue;

            for (const item of data) {
                if (!item.info_hash || item.info_hash === "0000000000000000000000000000000000000000") continue;

                const name = item.name;
                if (!ITA_REGEX.test(name)) continue;

                if (year) {
                    const y = parseInt(year);
                    if (![y - 1, y, y + 1].some(ay => name.includes(ay))) continue;
                }

                const hash = item.info_hash.toUpperCase();
                const seeders = parseInt(item.seeders || 0);
                const sizeBytes = parseInt(item.size || 0);

                const magnet = buildMagnet(hash, name);

                if (!resultsMap.has(hash) || seeders > resultsMap.get(hash).seeders) {
                    resultsMap.set(hash, {
                        title: name,
                        magnet,
                        size: (sizeBytes / 1073741824).toFixed(2) + " GB",
                        sizeBytes,
                        seeders,
                        source: "TPB"
                    });
                }
            }
        }

        return [...resultsMap.values()];
    } catch {
        return [];
    }
}

/* ===========================================================
   🔵 1337x SEARCH
   =========================================================== */
async function search1337x(title, year) {
    const cleanTitle = cleanString(title);
    let baseQuery = cleanTitle + (year ? ` ${year}` : "");

    const italianKeywords = [
        "ITA", "Italian", "Italiano", "sub ita", "AC3 ITA", "DTS ITA",
        "MULTI", "DUAL", "MD", "FORCED ITA", "CiNEFiLE", "NovaRip",
        "MeM", "robbyrs", "iDN_CreW", "PsO", "BadAss"
    ];

    const queries = [
        baseQuery,
        ...italianKeywords.map(k => `${baseQuery} ${k}`)
    ];

    const candidates = new Map();
    const headers = {
        "User-Agent": "Mozilla/5.0"
    };

    // Prima fase: raccolta liste
    for (const q of queries) {
        try {
            const url = `${BASE_1337X}/category-search/${encodeURIComponent(q)}/Movies/1/`;
            const { data } = await axios.get(url, { timeout: 15000, headers }).catch(() => ({ data: "" }));

            if (!data) continue;

            const $ = cheerio.load(data);
            $("table.table-list tbody tr").each((_, row) => {
                const tds = $(row).find("td");
                const nameLink = tds.eq(0).find("a").eq(1);

                if (!nameLink.length) return;

                const name = nameLink.text().trim();
                if (!ITA_REGEX.test(name)) return;

                const torrentPath = nameLink.attr("href");
                if (!torrentPath) return;

                if (year) {
                    const y = parseInt(year);
                    if (![y - 1, y, y + 1].some(ay => name.includes(ay))) return;
                }

                const seeders = parseInt(tds.eq(1).text().replace(/,/g, "")) || 0;

                const sizeText = tds.eq(4).text();
                const m = sizeText.match(/([\d.]+)\s*(GB|GiB|MB|MiB)/i);
                let sizeBytes = 0;

                if (m) {
                    const num = parseFloat(m[1]);
                    sizeBytes = m[2].toUpperCase().includes("G")
                        ? num * 1073741824
                        : num * 1048576;
                }

                if (!candidates.has(torrentPath) || seeders > candidates.get(torrentPath).seeders) {
                    candidates.set(torrentPath, {
                        name,
                        torrentUrl: BASE_1337X + torrentPath,
                        seeders,
                        sizeBytes
                    });
                }
            });
        } catch { }
    }

    // Seconda fase: recupero magnet
    const sorted = [...candidates.values()].sort((a, b) => b.seeders - a.seeders).slice(0, 60);

    const magnets = await Promise.all(sorted.map(async c => {
        try {
            const { data } = await axios.get(c.torrentUrl, { timeout: 10000, headers });
            const $ = cheerio.load(data);

            const magnet = $("a[href^='magnet:']").first().attr("href");
            if (!magnet) return null;

            const hashMatch = magnet.match(/btih:([A-F0-9]{40})/i);
            if (!hashMatch) return null;

            const hash = hashMatch[1].toUpperCase();
            const fullMagnet = buildMagnet(hash, c.name);

            return {
                title: c.name,
                magnet: fullMagnet,
                size: (c.sizeBytes / 1073741824).toFixed(2) + " GB",
                sizeBytes: c.sizeBytes,
                seeders: c.seeders,
                source: "1337x"
            };
        } catch {
            return null;
        }
    }));

    return magnets.filter(Boolean);
}

/* ===========================================================
   🔴 UNIFICA TUTTO
   =========================================================== */
async function searchMagnet(title, year) {
    console.log(`\n--- [ULTIMATE ITA SEARCH: TPB + 1337x] ${title} ${year || ""} ---`);

    const [tpb, x] = await Promise.all([
        searchTPB(title, year),
        search1337x(title, year)
    ]);

    console.log(`TPB: ${tpb.length} risultati`);
    console.log(`1337x: ${x.length} risultati`);

    const final = new Map();

    const add = r => {
        const m = r.magnet.match(/btih:([A-F0-9]{40})/i);
        if (!m) return;

        const hash = m[1].toUpperCase();

        if (!final.has(hash) || r.seeders > final.get(hash).seeders) {
            final.set(hash, r);
        }
    };

    tpb.forEach(add);
    x.forEach(add);

    const out = [...final.values()]
        .sort((a, b) => b.seeders - a.seeders || b.sizeBytes - a.sizeBytes)
        .slice(0, 6);

    console.log(`TOTALE UNICI con seeders massimi: ${out.length} (limitato a 5)`);

    return out;
}

module.exports = { searchMagnet };
