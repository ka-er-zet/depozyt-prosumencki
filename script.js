document.addEventListener('DOMContentLoaded', () => {
    const fileInput = document.getElementById('file-input');
    const calculateBtn = document.getElementById('calculate-btn');
    const statusDiv = document.getElementById('status');
    const resultsContainer = document.getElementById('results-container');
    const totalSummaryContainer = document.getElementById('total-summary-container');

    calculateBtn.addEventListener('click', handleCalculation);

    async function handleCalculation() {
        const files = fileInput.files;
        if (files.length === 0) {
            updateStatus('Proszę wybrać przynajmniej jeden plik CSV.', 'error');
            return;
        }

        // Reset UI
        const hourlyResultsContent = document.getElementById('hourly-results-content');
        const monthlyResultsContent = document.getElementById('monthly-results-content');
        
        hourlyResultsContent.innerHTML = '';
        monthlyResultsContent.innerHTML = '';
        resultsContainer.style.display = 'none';
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
                    displayResult(errorResult, 'hourly');
                    displayResult(errorResult, 'monthly');
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
                    displayResult(errorResult, 'hourly');
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
                    displayResult(errorResult, 'monthly');
                }

            } catch (error) {
                const errorResult = {
                    fileName: file.name,
                    error: `Wystąpił błąd: ${error.message}`
                };
                displayResult(errorResult, 'hourly');
                displayResult(errorResult, 'monthly');
            }
        }
        
        // Sort and display all results
        allHourlyResults.sort((a, b) => a.startDate - b.startDate);
        allMonthlyResults.sort((a, b) => a.startDate - b.startDate);
        
        allHourlyResults.forEach(result => displayResult(result, 'hourly'));
        allMonthlyResults.forEach(result => displayResult(result, 'monthly'));

        // Show results container
        resultsContainer.style.display = 'block';

        // Display total summary
        const validHourlyResults = allHourlyResults.filter(r => !r.error);
        const validMonthlyResults = allMonthlyResults.filter(r => !r.error);
        
        if (validHourlyResults.length > 0 || validMonthlyResults.length > 0) {
            displayTotalSummary(validHourlyResults, validMonthlyResults);
        }

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
        // (czyli dla energii oddanej od stycznia 2025)
        const cutoffDate = new Date('2025-01-01T00:00:00');
        const hasDataAfterCutoff = userData.some(row => row.energyKwh > 0 && row.dateTime >= cutoffDate);
        
        if (hasDataAfterCutoff) {
            totalValue *= 1.23;
        }

        return { totalValue, totalEnergy, multiplierApplied: hasDataAfterCutoff };
    }

    function calculateMonthlyDepositValue(userData, monthlyPrice, priceSource) {
        const totalEnergy = userData.reduce((sum, row) => sum + (row.energyKwh > 0 ? row.energyKwh : 0), 0);
        let totalValue = totalEnergy * monthlyPrice;

        // Współczynnik 1.23 stosowany dla depozytów ustalanych od lutego 2025
        // (czyli dla energii oddanej od stycznia 2025)
        const cutoffDate = new Date('2025-01-01T00:00:00');
        const hasDataAfterCutoff = userData.some(row => row.energyKwh > 0 && row.dateTime >= cutoffDate);
        
        if (hasDataAfterCutoff) {
            totalValue *= 1.23;
        }

        return { totalValue, totalEnergy, monthlyPrice, multiplierApplied: hasDataAfterCutoff, priceSource };
    }

    function displayResult(result, method) {
        const itemDiv = document.createElement('article');
        itemDiv.className = 'result-item';

        const monthYear = result.startDate ? new Intl.DateTimeFormat('pl-PL', { year: 'numeric', month: 'long' }).format(result.startDate) : 'Brak daty';

        if (result.error) {
            itemDiv.innerHTML = `
                <h3>Plik: ${result.fileName}</h3>
                <p><strong>Błąd:</strong> ${result.error}</p>
            `;
        } else {
            let priceInfo = '';
            if (result.calculationMethod === 'monthly') {
                priceInfo = `
                    <p><strong>Cena miesięczna (RCEm):</strong> ${result.monthlyPrice.toFixed(5)} PLN/kWh</p>
                    <p><small><strong>Źródło ceny:</strong> ${result.priceSource}</small></p>
                `;
                
                // Jeśli cena pochodzi z rcem.json lub z wbudowanej tabeli - informujemy użytkownika.
                // Brak oficjalnej RCEm jest sygnalizowany przez wyrzucony błąd wcześniej.
                if (result.priceSource) {
                    priceInfo += `<p><small>(${result.priceSource})</small></p>`;
                }
            } else {
                priceInfo = `<p><strong>Metoda:</strong> Rynkowa Cena Energii godzinowa (RCE/RCEt)</p>`;
            }

            let multiplierInfo = '';
            if (result.multiplierApplied) {
                multiplierInfo = `<p><mark><strong>Zastosowano współczynnik 1.23</strong> (depozyt ustalany od lutego 2025)</mark></p>`;
            }

            itemDiv.innerHTML = `
                <h3>${monthYear.charAt(0).toUpperCase() + monthYear.slice(1)}</h3>
                <p><strong>Plik:</strong> ${result.fileName}</p>
                ${priceInfo}
                <p><strong>Całkowita energia oddana:</strong> ${result.totalEnergy.toFixed(3)} kWh</p>
                <p><strong>Obliczona wartość depozytu:</strong> ${result.totalValue.toFixed(2)} PLN</p>
                ${multiplierInfo}
            `;
        }
        
        // Wybierz odpowiedni kontener
        const targetContainer = method === 'hourly' ? 
            document.getElementById('hourly-results-content') : 
            document.getElementById('monthly-results-content');
        
        targetContainer.appendChild(itemDiv);
    }

    function displayTotalSummary(hourlyResults, monthlyResults) {
        let summaryHtml = '<h2>Podsumowanie całkowite</h2>';
        
        if (hourlyResults.length > 0) {
            const hourlyTotalEnergy = hourlyResults.reduce((sum, r) => sum + r.totalEnergy, 0);
            const hourlyTotalValue = hourlyResults.reduce((sum, r) => sum + r.totalValue, 0);
            
            summaryHtml += `
                <h3>RCE/RCEt (ceny godzinowe)</h3>
                <p><strong>Łączna energia:</strong> ${hourlyTotalEnergy.toFixed(3)} kWh</p>
                <p><strong>Łączna wartość depozytu:</strong> ${hourlyTotalValue.toFixed(2)} PLN</p>
            `;
        }
        
        if (monthlyResults.length > 0) {
            const monthlyTotalEnergy = monthlyResults.reduce((sum, r) => sum + r.totalEnergy, 0);
            const monthlyTotalValue = monthlyResults.reduce((sum, r) => sum + r.totalValue, 0);
            
            summaryHtml += `
                <h3>RCEm (ceny miesięczne)</h3>
                <p><strong>Łączna energia:</strong> ${monthlyTotalEnergy.toFixed(3)} kWh</p>
                <p><strong>Łączna wartość depozytu:</strong> ${monthlyTotalValue.toFixed(2)} PLN</p>
            `;
            
            // Porównanie jeśli mamy oba wyniki
            if (hourlyResults.length > 0) {
                const hourlyTotalValue = hourlyResults.reduce((sum, r) => sum + r.totalValue, 0);
                const difference = monthlyTotalValue - hourlyTotalValue;
                const percentageDiff = ((difference / hourlyTotalValue) * 100);
                
                summaryHtml += `
                    <hr>
                    <h3>Porównanie metod</h3>
                    <p><strong>Różnica (RCEm - RCE):</strong> ${difference > 0 ? '+' : ''}${difference.toFixed(2)} PLN 
                    (${percentageDiff > 0 ? '+' : ''}${percentageDiff.toFixed(1)}%)</p>
                `;
            }
        }
        
        totalSummaryContainer.innerHTML = summaryHtml;
        totalSummaryContainer.style.display = 'block';
    }
});
