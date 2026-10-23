const fs = require('fs');

function buildFranchises(db) {
  const franchises = {};
  for (const [key, rules] of Object.entries(db.mappings)) {
    const parts = key.split(':');
    if (parts.length < 2) continue;
    
    // --- SKIP ANIDB FOR BLOBS (SEED & UPDATES) ---
    if (parts[0] === 'anidb') continue; 
    // ---------------------------------------------

    const franchiseId = `${parts[0]}:${parts[1]}`; 
    if (!franchises[franchiseId]) franchises[franchiseId] = { mappings: {} };
    franchises[franchiseId].mappings[key] = rules;
  }
  return franchises;
}

async function buildMasterDb() {
  console.log("Loading databases...");
  const anibridge = JSON.parse(fs.readFileSync('anibridge.json', 'utf8'));
  const cedya77 = JSON.parse(fs.readFileSync('cedya77.json', 'utf8'));

  console.log("Extracting Titles and IDs from Cedya77...");
  const animeData = {};
  for (const anime of cedya77.data) {
    const sources = anime.sources || [];
    const alSource = sources.find(s => s.includes('anilist.co/anime/'));
    if (!alSource) continue;
    const alId = alSource.split('/anime/')[1];

    const malSource = sources.find(s => s.includes('myanimelist.net/anime/'));
    const malId = malSource ? malSource.split('/anime/')[1] : null;

    const kitSource = sources.find(s => s.includes('kitsu.app/anime/') || s.includes('kitsu.io/anime/'));
    const kitsuId = kitSource ? kitSource.split('/anime/')[1] : null;

    // --- ASCII FILTER & SMART SORTING ---
    const rawTitles = [anime.title, ...(anime.synonyms || [])].filter(Boolean);
    const asciiTitles = rawTitles.filter(t => /^[\x00-\x7F]+$/.test(t));
    
    // 1. Shift the main title (usually Romaji) to the front
    const mainTitle = asciiTitles.shift(); 
    
    // 2. Sort the remaining synonyms so English titles and abbreviations come first
    const englishWords = /\b(the|of|to|in|and|is|on|for|a|an)\b/i;
    
    asciiTitles.sort((a, b) => {
      const aIsEnglish = englishWords.test(a) ? 1 : 0;
      const bIsEnglish = englishWords.test(b) ? 1 : 0;
      if (aIsEnglish !== bIsEnglish) return bIsEnglish - aIsEnglish;
      
      // If both or neither are English, prefer the shorter one
      return a.length - b.length;
    });
    
    // 3. Combine and cap at 6 titles to prevent scraper timeouts
    const finalTitles = [mainTitle, ...asciiTitles].slice(0, 6);

    animeData[alId] = {
      titles: finalTitles,
      malId,
      kitsuId,
      format: anime.type || null,
      status: anime.status || null,
      episodes: anime.episodes || null,
      year: anime.animeSeason && anime.animeSeason.year ? anime.animeSeason.year : null,
      season: anime.animeSeason && anime.animeSeason.season ? anime.animeSeason.season : null
    };
  }

  console.log("Mapping AniBridge episode ranges...");
  const mappings = {};
  let droppedAnilist = 0;
  let skippedMalformed = 0;
  let skippedLengthMismatch = 0;

  for (const [sourceKey, targets] of Object.entries(anibridge)) {
    if (sourceKey.startsWith('$') || !sourceKey.includes(':')) continue;

    const sourceParts = sourceKey.split(':');
    const sourceProvider = sourceParts[0].replace('_show', '').replace('_movie', '');
    const sourceId = sourceParts[1];
    const sourceSeason = sourceParts[2] || 's1';
    const normalizedSourceKey = `${sourceProvider}:${sourceId}:${sourceSeason}`;

    for (const [targetKey, rangeMap] of Object.entries(targets)) {
      if (targetKey.startsWith('$') || !targetKey.includes(':')) continue;

      const targetParts = targetKey.split(':');
      if (targetParts[0] !== 'anilist') continue;

      const anilistId = targetParts[1];
      if (!animeData[anilistId]) { droppedAnilist++; continue; }

      if (!mappings[normalizedSourceKey]) {
        mappings[normalizedSourceKey] = [];
      }

      for (const [srcRange, tgtRange] of Object.entries(rangeMap)) {
        const srcParts = String(srcRange).split('-');
        const tgtParts = String(tgtRange).split('-');

        const srcStart = Number(srcParts[0]);
        const srcEndRaw = srcParts.length > 1 ? Number(srcParts[1]) : srcStart;
        const tgtStart = Number(tgtParts[0]);
        const tgtEndRaw = tgtParts.length > 1 ? Number(tgtParts[1]) : tgtStart;

        if (!Number.isFinite(srcStart) || !Number.isFinite(srcEndRaw) || !Number.isFinite(tgtStart)) {
          skippedMalformed++;
          continue;
        }
        const srcEnd = srcEndRaw;

        const srcLen = srcEnd - srcStart + 1;
        const tgtLen = Number.isFinite(tgtEndRaw) ? (tgtEndRaw - tgtStart + 1) : 1;
        if (srcLen !== tgtLen) {
          skippedLengthMismatch++;
          continue;
        }

        mappings[normalizedSourceKey].push({
          srcStart,
          srcEnd,
          tgtStart,
          anilistId
        });
      }
    }
  }

  for (const key in mappings) {
    mappings[key].sort((a, b) => a.srcStart - b.srcStart);
  }

  const finalDb = { anime: animeData, mappings };

  // --- Validation ---
  const animeCount = Object.keys(animeData).length;
  const mappingCount = Object.keys(mappings).length;

  console.log("\nBuild stats:");
  console.log(`  anime entries: ${animeCount}`);
  console.log(`  mapping keys: ${mappingCount}`);
  console.log(`  dropped AniBridge targets: ${droppedAnilist}`);
  console.log(`  skipped malformed ranges: ${skippedMalformed}`);
  console.log(`  skipped length-mismatch ranges: ${skippedLengthMismatch}`);

  if (animeCount < 15000) throw new Error(`VALIDATION FAILED: anime count too low (${animeCount})`);
  if (mappingCount < 40000) throw new Error(`VALIDATION FAILED: mapping count too low (${mappingCount})`);

  // --- WRITE FLAT MASTER DB ---
  fs.writeFileSync('master-db.json', JSON.stringify(finalDb));
  console.log(`\nmaster-db.json built successfully! Size: ${(fs.statSync('master-db.json').size / 1024 / 1024).toFixed(2)} MB`);

  // --- FRANCHISE BUNDLING & DIFFING LOGIC ---
  console.log("\nGenerating franchise bundles...");
  
  const newFranchises = buildFranchises(finalDb);
  let oldFranchises = {};

  if (fs.existsSync('old-master-db.json')) {
    try {
      const oldDb = JSON.parse(fs.readFileSync('old-master-db.json', 'utf8'));
      oldFranchises = buildFranchises(oldDb);
      console.log("Loaded old-master-db.json for comparison.");
    } catch (e) {
      console.log("Could not parse old-master-db.json. Assuming fresh build.");
    }
  } else {
    console.log("No old-master-db.json found. All franchises will be marked as new.");
  }

  // --- WRITE FULL SEED DB ---
  const seedData = {
    anime: animeData, 
    franchises: newFranchises
  };
  
  fs.writeFileSync('seed.json', JSON.stringify(seedData));
  console.log(`seed.json built successfully! Size: ${(fs.statSync('seed.json').size / 1024 / 1024).toFixed(2)} MB`);

  // --- WRITE INCREMENTAL UPDATES DB ---
  const updates = { anime: {}, franchises: {} }; 
  let newCount = 0;
  let changedCount = 0;

  for (const [franchiseId, data] of Object.entries(newFranchises)) {
    const oldData = oldFranchises[franchiseId];
    if (!oldData || JSON.stringify(oldData) !== JSON.stringify(data)) {
      updates.franchises[franchiseId] = data;
      changedCount++;
      
      // If this franchise changed, we need to ensure its anime metadata is in the update
      for (const rules of Object.values(data.mappings)) {
        for (const rule of rules) {
          if (animeData[rule.anilistId] && !updates.anime[rule.anilistId]) {
            updates.anime[rule.anilistId] = animeData[rule.anilistId];
          }
        }
      }
    }
  }

  fs.writeFileSync('updates.json', JSON.stringify(updates));
  console.log(`updates.json built successfully! Size: ${(fs.statSync('updates.json').size / 1024).toFixed(2)} KB`);
  console.log(`  Changed Franchises: ${changedCount}, Anime Entries Included: ${Object.keys(updates.anime).length}`);
}

buildMasterDb().catch(err => {
  console.error(err);
  process.exit(1);
});
