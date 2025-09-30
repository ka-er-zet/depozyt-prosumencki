document.addEventListener('DOMContentLoaded', () => {
    const fileInput = document.getElementById('file-input');
    const calculateBtn = document.getElementById('calculate-btn');
    const statusDiv = document.getElementById('status');
    const resultsContainer = document.getElementById('results-container');
    const totalSummaryContainer = document.getElementById('total-summary-container');
    const dropZone = document.getElementById('drop-zone');
    const chooseFilesBtn = document.getElementById('choose-files');
    const fileListEl = document.getElementById('file-list');

    // internal list of selected files (File objects)
    let selectedFiles = [];

    function refreshFileList() {
        // Update single-line upload summary under the CTA
        const summaryEl = document.getElementById('upload-summary');
        if (!summaryEl) return;
        if (!selectedFiles || selectedFiles.length === 0) {
            summaryEl.textContent = '';
            // hide detailed file list
            if (fileListEl) fileListEl.style.display = 'none';
            return;
        }
        if (selectedFiles.length === 1) {
            summaryEl.textContent = `Załadowano plik: ${selectedFiles[0].name}`;
        } else {
            summaryEl.textContent = `Załadowano ${selectedFiles.length} plików`;
        }
        // hide detailed file list (we only show the single-line summary now)
        if (fileListEl) fileListEl.style.display = 'none';
    }

    if (chooseFilesBtn) {
        chooseFilesBtn.addEventListener('click', (e) => {
            e.preventDefault();
            fileInput.click();
        });
    }

    // make entire drop zone clickable and keyboard accessible
    if (dropZone) {
        dropZone.addEventListener('click', (e) => {
            fileInput.click();
        });
        dropZone.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                fileInput.click();
            }
        });
    }

    // wire native file input to update selectedFiles
    fileInput.addEventListener('change', (ev) => {
        const files = Array.from(ev.target.files || []);
        if (files.length) {
            selectedFiles = selectedFiles.concat(files);
            refreshFileList();
        }
    });

    // drag & drop handlers
    if (dropZone) {
        ['dragenter', 'dragover'].forEach(ev => dropZone.addEventListener(ev, (e) => {
            e.preventDefault(); e.stopPropagation();
            dropZone.classList.add('is-dragover');
        }));
        ['dragleave', 'drop'].forEach(ev => dropZone.addEventListener(ev, (e) => {
            e.preventDefault(); e.stopPropagation();
            dropZone.classList.remove('is-dragover');
        }));
        dropZone.addEventListener('drop', (e) => {
            const dtFiles = Array.from(e.dataTransfer.files || []);
            if (dtFiles.length) {
                // filter for .csv
                const csvs = dtFiles.filter(f => f.name.toLowerCase().endsWith('.csv'));
                selectedFiles = selectedFiles.concat(csvs);
                refreshFileList();
            }
        });
    }

    calculateBtn.addEventListener('click', handleCalculation);

    async function handleCalculation() {
        const files = selectedFiles;
        if (!files || files.length === 0) {
            updateStatus('Proszę wybrać przynajmniej jeden plik CSV.', 'error');
            return;
        }

    // Reset UI
    const monthsContainer = document.getElementById('months-container');
    if (monthsContainer) monthsContainer.innerHTML = '';
    if (resultsContainer) resultsContainer.style.display = 'none';
    totalSummaryContainer.innerHTML = '';
    totalSummaryContainer.style.display = 'none';
        calculateBtn.setAttribute('aria-busy', 'true');
        calculateBtn.disabled = true;

        const allHourlyResults = [];
        const allMonthlyResults = [];

        for (const file of files) {
            try {
                updateStatus(`Przetwarzanie pliku: ${file.name}...`);
                const userData = await parseCsv(file);
                
                if (!userData || userData.length === 0) {
                    const errorResult = {
                        fileName: file.name,
                        error: 'Nie znaleziono poprawnych danych w pliku.'
                    };
                    displayError(errorResult);
                    continue;
                }

                const { minDate, maxDate } = getMinMaxDates(userData);
                
                // Oblicz oba warianty jednocześnie
                let hourlyResult = null;
                let monthlyResult = null;

                try {
                    updateStatus(`Pobieranie cen godzinowych (RCE/RCEt) dla pliku ${file.name}...`);
                    const marketPrices = await fetchHourlyMarketPrices(minDate, maxDate);
                    if (marketPrices) {
                        hourlyResult = calculateHourlyDepositValue(userData, marketPrices);
                        hourlyResult.fileName = file.name;
                        hourlyResult.startDate = minDate;
                        hourlyResult.calculationMethod = 'hourly';
                        allHourlyResults.push(hourlyResult);
                    } else {
                        throw new Error('Nie udało się pobrać cen godzinowych.');
                    }
                } catch (hourlyError) {
                    const errorResult = {
                        fileName: file.name,
                        error: `Błąd RCE: ${hourlyError.message}`,
                        calculationMethod: 'hourly'
                    };
                    displayError(errorResult);
                }

                try {
                    updateStatus(`Pobieranie ceny miesięcznej (RCEm) dla pliku ${file.name}...`);
                    const monthlyData = await fetchMonthlyMarketPrice(minDate, maxDate);
                    if (monthlyData !== null) {
                        monthlyResult = calculateMonthlyDepositValue(userData, monthlyData.price, monthlyData.source);
                        monthlyResult.fileName = file.name;
                        monthlyResult.startDate = minDate;
                        monthlyResult.calculationMethod = 'monthly';
                        allMonthlyResults.push(monthlyResult);
                    } else {
                        throw new Error('Nie udało się pobrać ceny miesięcznej.');
                    }
                } catch (monthlyError) {
                    const errorResult = {
                        fileName: file.name,
                        error: `Błąd RCEm: ${monthlyError.message}`,
                        calculationMethod: 'monthly'
                    };
                    displayError(errorResult);
                }

            } catch (error) {
                const errorResult = {
                    fileName: file.name,
                    error: `Wystąpił błąd: ${error.message}`
                };
                displayError(errorResult);
            }
        }
        
        // Sort results by date
        allHourlyResults.sort((a, b) => a.startDate - b.startDate);
        allMonthlyResults.sort((a, b) => a.startDate - b.startDate);

        // Build per-month map where key = YYYY-MM
        const monthMap = {};
        function putIntoMap(arr, kind) {
            for (const r of arr) {
                if (!r || r.error || !r.startDate) continue;
                const key = `${r.startDate.getFullYear()}-${String(r.startDate.getMonth() + 1).padStart(2,'0')}`;
                monthMap[key] = monthMap[key] || {};
                monthMap[key][kind] = r;
            }
        }
        putIntoMap(allMonthlyResults, 'monthly');
        putIntoMap(allHourlyResults, 'hourly');

        // Prepare keys and containers
        const keys = Object.keys(monthMap).sort();
        const accordion = document.getElementById('accordion-container');
        const detailsHeading = document.getElementById('details-heading');

        // Show summary first
        const validHourlyResults = allHourlyResults.filter(r => !r.error && r.startDate);
        const validMonthlyResults = allMonthlyResults.filter(r => !r.error && r.startDate);
        if (validHourlyResults.length > 0 || validMonthlyResults.length > 0) {
            displayTotalSummary(validHourlyResults, validMonthlyResults, keys);
        }

        // Then build accordion of months (each month in a closed <details>)
        if (accordion) {
            accordion.innerHTML = '';
            if (keys.length > 0) {
                detailsHeading.style.display = 'block';
                accordion.style.display = 'block';
                for (const k of keys) {
                    const monthParts = k.split('-');
                    const monthLabel = new Intl.DateTimeFormat('pl-PL', { year: 'numeric', month: 'long' }).format(new Date(`${monthParts[0]}-${monthParts[1]}-01`));

                    const details = document.createElement('details');
                    const summary = document.createElement('summary');
                    summary.textContent = monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1);
                    details.appendChild(summary);

                    // create month card and remove its H3 (we want header in summary)
                    const card = renderMonthCard(k, monthMap[k].monthly, monthMap[k].hourly);
                    const h3 = card.querySelector('h3');
                    if (h3) h3.remove();
                    details.appendChild(card);

                    accordion.appendChild(details);
                }
            } else {
                detailsHeading.style.display = 'none';
                accordion.style.display = 'none';
            }
        }

        // show results area (summary + accordion)
        totalSummaryContainer.style.display = 'block';

        updateStatus('Zakończono przetwarzanie wszystkich plików.', 'success');
        calculateBtn.removeAttribute('aria-busy');
        calculateBtn.disabled = false;
    }

    function updateStatus(message, type = 'info') {
        statusDiv.innerHTML = message;
        // W Pico.css nie ma klas error/success, więc to tylko dla logiki
    }

    function parseCsv(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    const text = event.target.result;
                    const lines = text.split(/\r?\n/).filter(line => line.trim() !== '');
                    if (lines.length < 2) {
                        return resolve([]);
                    }

                    const header = lines[0].split(';').map(h => h.trim());
                    const dateIndex = header.indexOf('Data');
                    const valueIndex = header.indexOf('Wartość kWh');

                    if (dateIndex === -1 || valueIndex === -1) {
                        return reject(new Error('Nie znaleziono wymaganych kolumn: "Data" i "Wartość kWh".'));
                    }

                    const data = [];
                    for (let i = 1; i < lines.length; i++) {
                        const columns = lines[i].split(';');
                        let timestampStr = columns[dateIndex];
                        const energyStr = columns[valueIndex];

                        if (!timestampStr || !energyStr) continue;

                        // Handle "24:00" case
                        let date = new Date(timestampStr.replace(' 24:00', ' 00:00'));
                        if (timestampStr.includes(' 24:00')) {
                            date.setDate(date.getDate() + 1);
                        }
                        
                        // Set minutes to the beginning of the hour for matching
                        date.setMinutes(0, 0, 0);

                        const energy = parseFloat(energyStr.replace(',', '.'));

                        if (!isNaN(date.getTime()) && !isNaN(energy)) {
                            data.push({ dateTime: date, energyKwh: energy });
                        }
                    }
                    resolve(data);
                } catch (e) {
                    reject(e);
                }
            };
            reader.onerror = () => reject(new Error('Nie udało się odczytać pliku.'));
            reader.readAsText(file, 'utf-8');
        });
    }

    function getMinMaxDates(userData) {
        if (userData.length === 0) return { minDate: null, maxDate: null };
        let minDate = userData[0].dateTime;
        let maxDate = userData[0].dateTime;
        for (const row of userData) {
            if (row.dateTime < minDate) minDate = row.dateTime;
            if (row.dateTime > maxDate) maxDate = row.dateTime;
        }
        return { minDate, maxDate };
    }

    async function fetchHourlyMarketPrices(startDate, endDate) {
        // Najpierw spróbuj skorzystać z lokalnego rce.json (jeśli jest dostępny obok strony)
        // Format rce.json: map ISO datetime -> price (PLN/kWh)
        const toIso = (d) => d.toISOString().replace(/\.\d+Z$/, 'Z');
        const startIsoDate = new Date(startDate);
        const endIsoDate = new Date(endDate);
        // end exclusive for iteration convenience
        endIsoDate.setHours(23, 59, 59, 999);

        let localData = null;
        try {
            const resp = await fetch('rce.json', { cache: 'no-store' });
            if (resp.ok) {
                localData = await resp.json();
            }
        } catch (e) {
            // ignore - file may not exist
        }

        const results = [];

        if (localData) {
            // iterate through localData keys in the requested range
            for (const [k, v] of Object.entries(localData)) {
                const dt = new Date(k);
                if (dt >= startDate && dt <= endIsoDate) {
                    results.push({ dateTime: dt, pricePlnKwh: Math.max(0, Number(v)) });
                }
            }
            if (results.length > 0) {
                // sort by datetime
                results.sort((a, b) => a.dateTime - b.dateTime);
                return results;
            }
            // if local data present but none in range, fall back to API
        }

        // Fallback: fetch from PSE API for the requested date range
        const formatDate = (date) => date.toISOString().split('T')[0];
        const apiEndDate = new Date(endDate);
        apiEndDate.setDate(apiEndDate.getDate() + 1);

        let url = `https://api.raporty.pse.pl/api/rce-pln?$filter=business_date ge '${formatDate(startDate)}' and business_date lt '${formatDate(apiEndDate)}'`;
        const allData = [];
        try {
            while (url) {
                const response = await fetch(url, { headers: { 'Accept': 'application/json' } });
                if (!response.ok) throw new Error(`Błąd serwera PSE (Status: ${response.status})`);
                const jsonResponse = await response.json();
                if (jsonResponse.value) allData.push(...jsonResponse.value);
                url = jsonResponse.nextLink;
            }

            if (allData.length === 0) return null;

            const finalPrices = [];
            for (const item of allData) {
                const dtimeCleaned = item.dtime.replace('a', '').replace('b', '');
                const dateTime = new Date(dtimeCleaned);
                const price = Math.max(0, item.rce_pln / 1000);
                finalPrices.push({ dateTime: dateTime, pricePlnKwh: price });
            }
            return finalPrices;
        } catch (error) {
            console.error("Błąd podczas pobierania cen godzinowych:", error);
            updateStatus(`Błąd podczas pobierania cen godzinowych: ${error.message}`, 'error');
            return null;
        }
    }

async function fetchMonthlyMarketPrice(minDate, maxDate) {
    // Wyciągnij rok i miesiąc z minDate
    const year = minDate.getFullYear();
    const month = minDate.getMonth() + 1;

    // Najpierw spróbuj pobrać oficjalną wartość RCEm z PSE
    try {
        const officialResult = await fetchOfficialRCEm(month, year);
        if (officialResult && officialResult.price !== null) {
            const officialPrice = officialResult.price;
            const sourceTag = officialResult.source === 'rcem.json' ? ' [z rcem.json]' : (officialResult.source === 'builtin' ? ' [z wbudowanej tabeli]' : '');
            console.log(`Używam oficjalnej RCEm dla ${year}-${month}: ${(officialPrice * 1000).toFixed(2)} zł/MWh → ${officialPrice.toFixed(5)} zł/kWh`);
            return {
                price: officialPrice,
                source: `Oficjalna RCEm z PSE (${year}-${month.toString().padStart(2, '0')}): ${(officialPrice * 1000).toFixed(2)} zł/MWh${sourceTag}`
            };
        }
    } catch (error) {
        console.warn('Nie udało się pobrać oficjalnej RCEm, używam obliczeń na podstawie RCE:', error);
    }

    // BRAK FALLBACK'U - obliczenia na podstawie średniej RCE dają ogromne błędy!
    // RCEm to oficjalne średnie miesięczne ceny energii liczone przez PSE
    // Średnia arytmetyczna z RCE godzinowych to zupełnie inna wartość
    throw new Error(`Brak oficjalnych danych RCEm dla ${year}-${month.toString().padStart(2, '0')}. PSE publikuje te dane zwykle z 1-2 miesięcznym opóźnieniem. Spróbuj metody obliczeń godzinowych (RCE) jako alternatywy.`);
}

// Oficjalne wartości RCEm z PSE (w zł/MWh - zawsze najnowsze skorygowane gdy dostępne)
const OFFICIAL_RCEM_VALUES = {
    '2025': {
        1: 480.01,   // styczeń
        2: 442.02,   // luty  
        3: 182.96,   // marzec
        4: 163.19,   // kwiecień
        5: 216.97,   // maj
        6: 136.30,   // czerwiec
        7: 284.83,   // lipiec
    },
    '2024': {
        1: 437.02,   // styczeń
        2: 323.17,   // luty (skorygowana z 11.06.2024)
        3: 247.85,   // marzec (skorygowana z 11.03.2025)
        4: 251.93,   // kwiecień (skorygowana z 11.08.2024)
        5: 254.19,   // maj (skorygowana z 11.09.2024)
        6: 328.81,   // czerwiec (skorygowana z 11.06.2025)
        7: 281.72,   // lipiec (skorygowana z 11.11.2024)
        8: 240.00,   // sierpień (skorygowana z 11.08.2025)
        9: 220.56,   // wrzesień (skorygowana z 11.01.2025)
        10: 285.58,  // październik (skorygowana z 11.02.2025)
        11: 394.45,  // listopad (skorygowana z 11.03.2025)
        12: 468.28   // grudzień (skorygowana z 11.02.2025)
    },
    '2023': {
        1: 594.59,   // styczeń (skorygowana z 11.05.2023)
        2: 668.51,   // luty (skorygowana z 11.06.2023)
        3: 508.90,   // marzec (skorygowana z 11.07.2023)
        4: 505.44,   // kwiecień (skorygowana z 11.06.2023)
        5: 380.42,   // maj (skorygowana z 11.09.2023)
        6: 453.88,   // czerwiec (skorygowana z 11.10.2023)
        7: 439.22,   // lipiec (skorygowana z 11.11.2023)
        8: 412.33,   // sierpień (skorygowana z 11.12.2023)
        9: 404.82,   // wrzesień (skorygowana z 11.01.2024)
        10: 329.25,  // październik (skorygowana z 11.02.2024)
        11: 377.08,  // listopad (skorygowana z 11.03.2024)
        12: 305.15   // grudzień (skorygowana z 11.12.2024)
    },
    '2022': {
        6: 656.04,   // czerwiec (skorygowana z 11.10.2022)
        7: 796.27,   // lipiec (skorygowana z 11.09.2022)
        8: 1017.27,  // sierpień (skorygowana z 11.08.2023)
        9: 710.03,   // wrzesień (skorygowana z 11.01.2023)
        10: 575.48,  // październik (skorygowana z 11.02.2023)
        11: 701.67,  // listopad (skorygowana z 11.03.2023)
        12: 723.49   // grudzień (skorygowana z 11.04.2023)
    }
};

// Funkcja do pobierania oficjalnych wartości RCEm z PSE
// Zwraca obiekt { price: <zł/kWh|null>, source: 'rcem.json'|'builtin'|null }
async function fetchOfficialRCEm(month, year) {
    // Dynamiczne ładowanie pliku rcem.json (jeśli dostępny w repo/GitHub Pages)
    if (typeof window.__RCEM_LOADED === 'undefined') {
        window.__RCEM_LOADED = false;
        window.__RCEM_DATA = {};
    }

    async function tryLoadRemote() {
        try {
            const resp = await fetch('rcem.json', { cache: 'no-store' });
            if (!resp.ok) return;
            const data = await resp.json();
            if (data && typeof data === 'object') {
                window.__RCEM_DATA = data;
            }
        } catch (e) {
            // ignore: file may not exist when running locally
        } finally {
            window.__RCEM_LOADED = true;
        }
    }

    if (!window.__RCEM_LOADED) {
        try {
            await tryLoadRemote();
        } catch (e) {
            window.__RCEM_LOADED = true;
        }
    }

    // Preferuj wartość z rcem.json jeżeli istnieje
    if (window.__RCEM_DATA && window.__RCEM_DATA[year] && window.__RCEM_DATA[year][String(month)]) {
        const priceMwh = window.__RCEM_DATA[year][String(month)];
        if (priceMwh !== null && priceMwh !== undefined) {
            console.log(`Znaleziono RCEm w rcem.json dla ${year}-${month}: ${priceMwh} zł/MWh`);
            return { price: priceMwh / 1000, source: 'rcem.json' };
        }
    }

    // Następnie sprawdź wbudowaną tabelę OFFICIAL_RCEM_VALUES
    if (OFFICIAL_RCEM_VALUES[year] && OFFICIAL_RCEM_VALUES[year][month]) {
        // Konwertuj z zł/MWh na zł/kWh (podziel przez 1000)
        return { price: OFFICIAL_RCEM_VALUES[year][month] / 1000, source: 'builtin' };
    }

    // Brak danych w żadnym źródle
    return { price: null, source: null };
}

// Spróbuj wczytać rcem.json podczas załadowania strony i nadpisać wbudowaną tabelę
(async function eagerLoadRcemJson() {
    try {
        const resp = await fetch('rcem.json', { cache: 'no-store' });
        if (!resp.ok) return;
        const data = await resp.json();
        if (data && typeof data === 'object') {
            // Skopiuj wartości do OFFICIAL_RCEM_VALUES (zł/MWh)
            for (const [year, months] of Object.entries(data)) {
                if (!OFFICIAL_RCEM_VALUES[year]) OFFICIAL_RCEM_VALUES[year] = {};
                for (const [m, v] of Object.entries(months)) {
                    // zachowujemy typ number
                    OFFICIAL_RCEM_VALUES[year][Number(m)] = v;
                }
            }
            // Ustaw też cache dla fetchOfficialRCEm
            window.__RCEM_DATA = data;
            window.__RCEM_LOADED = true;
            console.log('rcem.json załadowany i scalony z OFFICIAL_RCEM_VALUES');
        }
    } catch (e) {
        // ignore failures (file may not be present when opened locally via file://)
    }
})();

    function calculateHourlyDepositValue(userData, marketPrices) {
        // Grupujemy dane użytkownika i ceny po godzinach
        const hourlyData = {};
        
        // Najpierw dodajemy dane użytkownika
        for (const userRow of userData) {
            if (userRow.energyKwh > 0) {
                const hourKey = new Date(userRow.dateTime);
                hourKey.setMinutes(0, 0, 0);
                const hourKeyStr = hourKey.toISOString();
                
                if (!hourlyData[hourKeyStr]) {
                    hourlyData[hourKeyStr] = { userEnergy: 0, prices: [], energies: [] };
                }
                hourlyData[hourKeyStr].userEnergy += userRow.energyKwh;
            }
        }
        
        // Potem dodajemy ceny 15-minutowe
        for (const priceRow of marketPrices) {
            const hourKey = new Date(priceRow.dateTime);
            hourKey.setMinutes(0, 0, 0);
            const hourKeyStr = hourKey.toISOString();
            
            if (hourlyData[hourKeyStr] && hourlyData[hourKeyStr].userEnergy > 0) {
                // Zakładamy równomierny rozkład energii w ciągu godziny
                const energyPer15Min = hourlyData[hourKeyStr].userEnergy / 4;
                hourlyData[hourKeyStr].prices.push(priceRow.pricePlnKwh);
                hourlyData[hourKeyStr].energies.push(energyPer15Min);
            }
        }
        
        // Obliczamy średnią ważoną dla każdej godziny i sumujemy wartość
        let totalValue = 0;
        let totalEnergy = 0;
        
        for (const hourKeyStr in hourlyData) {
            const hour = hourlyData[hourKeyStr];
            if (hour.prices.length > 0 && hour.energies.length > 0) {
                // Średnia ważona: suma(energia_i * cena_i) / suma(energia_i)
                const weightedSum = hour.prices.reduce((sum, price, i) => sum + (price * hour.energies[i]), 0);
                const totalEnergyInHour = hour.energies.reduce((sum, energy) => sum + energy, 0);
                const weightedAvgPrice = weightedSum / totalEnergyInHour;
                
                totalValue += hour.userEnergy * weightedAvgPrice;
                totalEnergy += hour.userEnergy;
            }
        }

        // Współczynnik 1.23 stosowany dla depozytów ustalanych od lutego 2025
        const cutoffDate = new Date('2025-01-01T00:00:00');
        const multiplierApplied = userData.some(row => row.energyKwh > 0 && row.dateTime >= cutoffDate);

        const baseValue = totalValue;
        const multipliedValue = multiplierApplied ? baseValue * 1.23 : baseValue;

        // Round energy to integer (as requested) and values to 2 decimals
        return { totalValue: +baseValue.toFixed(2), totalEnergy: Math.round(totalEnergy), multipliedValue: +multipliedValue.toFixed(2), multiplierApplied };
    }

    function calculateMonthlyDepositValue(userData, monthlyPrice, priceSource) {
        const totalEnergy = userData.reduce((sum, row) => sum + (row.energyKwh > 0 ? row.energyKwh : 0), 0);
        const baseValue = totalEnergy * monthlyPrice;
        const cutoffDate = new Date('2025-01-01T00:00:00');
        const multiplierApplied = userData.some(row => row.energyKwh > 0 && row.dateTime >= cutoffDate);
        const multipliedValue = multiplierApplied ? baseValue * 1.23 : baseValue;
        return { totalValue: +baseValue.toFixed(2), totalEnergy: Math.round(totalEnergy), monthlyPrice, multipliedValue: +multipliedValue.toFixed(2), multiplierApplied, priceSource };
    }

    // Render per-month card combining monthly and hourly data
    function renderMonthCard(key, monthly, hourly) {
        const container = document.createElement('article');
        container.className = 'result-item';

        // key = YYYY-MM
        const [y, m] = key.split('-');
        const monthName = new Intl.DateTimeFormat('pl-PL', { year: 'numeric', month: 'long' }).format(new Date(`${y}-${m}-01`));

        // Calculate totalEnergy (prefer monthly.totalEnergy if present, else hourly)
        const totalEnergy = (monthly && typeof monthly.totalEnergy === 'number') ? monthly.totalEnergy : (hourly && typeof hourly.totalEnergy === 'number' ? hourly.totalEnergy : 0);

        // Monthly block with grid layout and badges
        const rceValue = hourly && typeof hourly.totalValue === 'number' ? hourly.totalValue.toFixed(2) : null;
        const rceValueMult = hourly && typeof hourly.multipliedValue === 'number' ? hourly.multipliedValue.toFixed(2) : null;
        const rcemPrice = monthly && typeof monthly.monthlyPrice === 'number' ? monthly.monthlyPrice.toFixed(5) : null;
        const rcemValue = monthly && typeof monthly.totalValue === 'number' ? monthly.totalValue.toFixed(2) : null;
        const rcemValueMult = monthly && typeof monthly.multipliedValue === 'number' ? monthly.multipliedValue.toFixed(2) : null;

        // Badges for sections (RCEm badge includes price)
    // Add a single 'Dane PSE' badge next to the hourly prices title
    const rceSectionBadge = rceValue ? '<span class="badge badge-rce">Ceny godzinowe - RCE</span> <span class="badge badge-estimate">Dane PSE</span>' : '<span class="badge badge-missing">brak RCE</span>';
        // RCEm: separate label badge and value badge (value shown in its own badge)
        let rcemSectionBadge;
        if (rcemPrice) {
            rcemSectionBadge = `<span class="badge badge-rcem">Cena miesięczna - RCEm</span> <span class="badge badge-rcem">${rcemPrice} zł/kWh</span>`;
        } else {
            rcemSectionBadge = '<span class="badge badge-missing">brak RCEm</span>';
        }

        container.innerHTML = `
            <h3>${monthName.charAt(0).toUpperCase() + monthName.slice(1)}</h3>
            <p><strong>Całkowita energia oddana:</strong> <span class="stat">${totalEnergy}</span> <span class="unit">kWh</span></p>
            <div class="card-grid">
                <div class="card-section">
                    <div class="badge-row-separator">${rceSectionBadge}</div>
                    <p>Wartość depozytu: <span class="stat">${rceValue !== null ? rceValue : '--'}</span> <span class="unit">PLN</span></p>
                    <p>Wartość (×1.23): <span class="stat">${rceValueMult !== null ? rceValueMult : '--'}</span> <span class="unit">PLN</span></p>
                </div>
                <div class="card-section">
                    <div class="badge-row-separator">${rcemSectionBadge}</div>
                    <p>Wartość depozytu: <span class="stat">${rcemValue !== null ? rcemValue : '--'}</span> <span class="unit">PLN</span></p>
                    <p>Wartość (×1.23): <span class="stat">${rcemValueMult !== null ? rcemValueMult : '--'}</span> <span class="unit">PLN</span></p>
                </div>
            </div>
        `;
        return container;
    }

    // Display an error card when a file couldn't be processed
    function displayError(err) {
        const accordion = document.getElementById('accordion-container');
        const itemDiv = document.createElement('article');
        itemDiv.className = 'result-item';
        itemDiv.innerHTML = `
            <h3>Plik: ${err.fileName || 'Brak nazwy'}</h3>
            <p><strong>Błąd:</strong> ${err.error || 'Nieznany błąd'}</p>
        `;
        if (accordion) accordion.appendChild(itemDiv);
    }

    function displayTotalSummary(hourlyResults, monthlyResults, keys) {
        const summaryEl = document.getElementById('total-summary-container');
        let start = null, end = null;
        if (keys && keys.length > 0) {
            start = keys[0];
            end = keys[keys.length-1];
        }

        // Build maps for monthly and hourly by YYYY-MM
        const monthlyMap = {};
        for (const m of monthlyResults) {
            const key = `${m.startDate.getFullYear()}-${String(m.startDate.getMonth()+1).padStart(2,'0')}`;
            monthlyMap[key] = m;
        }
        const hourlyMap = {};
        for (const h of hourlyResults) {
            const key = `${h.startDate.getFullYear()}-${String(h.startDate.getMonth()+1).padStart(2,'0')}`;
            hourlyMap[key] = h;
        }

        // Sum per-key energies preferring monthly totalEnergy when present
        let totalEnergySum = 0;
        if (keys && keys.length > 0) {
            for (const k of keys) {
                if (monthlyMap[k] && typeof monthlyMap[k].totalEnergy === 'number') totalEnergySum += monthlyMap[k].totalEnergy;
                else if (hourlyMap[k] && typeof hourlyMap[k].totalEnergy === 'number') totalEnergySum += hourlyMap[k].totalEnergy;
            }
        }

        // Build a card-like layout matching per-month cards
        let html = '';
        html += `<h3>Podsumowanie</h3>`;
        if (start && end) {
            const startLabel = new Intl.DateTimeFormat('pl-PL', { year: 'numeric', month: 'long' }).format(new Date(`${start}-01`));
            const endLabel = new Intl.DateTimeFormat('pl-PL', { year: 'numeric', month: 'long' }).format(new Date(`${end}-01`));
            html += `<p>Za okres: ${startLabel} do ${endLabel}</p>`;
        }

        html += `<p><strong>Łączna energia oddana:</strong> <span class="stat">${Math.round(totalEnergySum)}</span> <span class="unit">kWh</span></p>`;

        // Card-grid with two sections (RCE and RCEm)
        html += `<div class="card-grid">`;

        // RCE section
        const hasHourly = hourlyResults.length > 0;
        if (hasHourly) {
            const hourlyTotalValue = hourlyResults.reduce((s,r)=>s + r.totalValue, 0);
            const hourlyTotalMult = hourlyResults.reduce((s,r)=>s + r.multipliedValue, 0);
            const rceBadge = `<span class="badge badge-rce">Ceny godzinowe - RCE</span> <span class="badge badge-estimate">Dane PSE</span>`;
            html += `
                <div class="card-section">
                    <div class="badge-row-separator">${rceBadge}</div>
                    <p>Wartość depozytu: <span class="stat">${hourlyTotalValue.toFixed(2)}</span> <span class="unit">PLN</span></p>
                    <p>Wartość (×1.23): <span class="stat">${hourlyTotalMult.toFixed(2)}</span> <span class="unit">PLN</span></p>
                </div>
            `;
        } else {
            html += `
                <div class="card-section">
                    <div class="badge-row-separator"><span class="badge badge-missing">brak RCE</span></div>
                    <p>Wartość depozytu: <span class="stat">--</span> <span class="unit">PLN</span></p>
                    <p>Wartość (×1.23): <span class="stat">--</span> <span class="unit">PLN</span></p>
                </div>
            `;
        }

        // RCEm section
        if (monthlyResults.length > 0) {
            const monthlyTotalValue = monthlyResults.reduce((s,r)=>s + r.totalValue, 0);
            const monthlyTotalMult = monthlyResults.reduce((s,r)=>s + r.multipliedValue, 0);
            const rcemBadge = `<span class="badge badge-rcem">Cena miesięczna - RCEm</span>`;
            html += `
                <div class="card-section">
                    <div class="badge-row-separator">${rcemBadge}</div>
                    <p>Wartość depozytu: <span class="stat">${monthlyTotalValue.toFixed(2)}</span> <span class="unit">PLN</span></p>
                    <p>Wartość (×1.23): <span class="stat">${monthlyTotalMult.toFixed(2)}</span> <span class="unit">PLN</span></p>
                </div>
            `;
        } else {
            html += `
                <div class="card-section">
                    <div class="badge-row-separator"><span class="badge badge-missing">brak RCEm</span></div>
                    <p>Wartość depozytu: <span class="stat">--</span> <span class="unit">PLN</span></p>
                    <p>Wartość (×1.23): <span class="stat">--</span> <span class="unit">PLN</span></p>
                </div>
            `;
        }

        html += `</div>`;

        summaryEl.innerHTML = html;
        summaryEl.style.display = 'block';
    }
});
