import pandas as pd
import requests
import sys
import glob # Biblioteka do wyszukiwania plików
import os   # Biblioteka do operacji na systemie plików
import locale # Biblioteka do ustawień regionalnych (dla polskich nazw miesięcy)

# Ustawienie polskiego języka dla nazw miesięcy w podsumowaniu
try:
    locale.setlocale(locale.LC_TIME, 'pl_PL.UTF-8')
except locale.Error:
    print("Ostrzeżenie: Nie udało się ustawić polskich nazw miesięcy. Podsumowanie może być w języku angielskim.")


def wczytaj_dane_uzytkownika(nazwa_pliku):
    """Wczytuje i przetwarza pojedynczy plik CSV od użytkownika."""
    try:
        # print(f"\n--- Przetwarzanie pliku: {nazwa_pliku} ---")
        # print("Krok 1: Wczytywanie Twoich danych...")

        df = pd.read_csv(nazwa_pliku, sep=';', decimal=',', encoding='utf-8')

        # Usuń nadmiarowe spacje w nazwach kolumn (np. ' Wartość kWh') żeby dopasować mapowanie nazw
        df.columns = df.columns.str.strip()

        df.rename(columns={'Data': 'TimestampStr', 'Wartość kWh': 'Energia_kWh'}, inplace=True)

        # Usunięcie wierszy, które mogą nie mieć daty
        df.dropna(subset=['TimestampStr'], inplace=True)

        df['DateTime'] = pd.to_datetime(df['TimestampStr'].str.replace(' 24:00', ' 00:00'), errors='coerce')
        df.loc[df['TimestampStr'].str.contains(' 24:00'), 'DateTime'] += pd.Timedelta(days=1)

        # Sprawdzenie, czy są jakieś dane po przetworzeniu
        if df.empty or df['DateTime'].isnull().all():
            print(f"❌ BŁĄD: Plik '{nazwa_pliku}' nie zawiera poprawnych danych z datami.")
            return None

        # print("✅ Twoje dane zostały wczytane i przetworzone.")
        return df[['DateTime', 'Energia_kWh']]

    except FileNotFoundError:
        print(f"❌ BŁĄD: Nie znaleziono pliku '{nazwa_pliku}'.")
        return None
    except Exception as e:
        print(f"❌ BŁĄD: Wystąpił nieoczekiwany problem podczas wczytywania pliku '{nazwa_pliku}': {e}")
        return None

def pobierz_ceny_rynkowe(start_date, end_date):
    """Pobiera Rynkową Cenę Energii (RCE) z API PSE i uśrednia ją do wartości godzinowych."""
    
    # Dodajemy jeden dzień do daty końcowej, aby na pewno pobrać wszystkie dane dla ostatniego dnia
    end_date_api = end_date + pd.Timedelta(days=1)
    
    start_str = start_date.strftime('%Y-%m-%d')
    end_str = end_date_api.strftime('%Y-%m-%d')
    
    # Nowy URL do API PSE dla RCE z filtrem OData
    # Używamy 'ge' (greater or equal) i 'lt' (less than) do filtrowania po business_date
    # Ważne: daty muszą być w pojedynczych cudzysłowach
    url = f"https://api.raporty.pse.pl/api/rce-pln?$filter=business_date ge '{start_str}' and business_date lt '{end_str}'"
    
    # print(f"Krok 2: Pobieranie cen RCE z PSE dla okresu od {start_str} do {end_str}...")
    
    all_data = []
    
    try:
        while url:
            # print(f"   -> Pobieranie danych z: {url[:100]}...")
            response = requests.get(url, timeout=30)
            
            if response.status_code != 200:
                print(f"❌ BŁĄD: Serwer PSE zwrócił błąd (Status: {response.status_code}).")
                print(f"   Treść odpowiedzi: {response.text[:200]}")
                return None

            json_response = response.json()
            data = json_response.get('value')
            
            if data:
                all_data.extend(data)
            
            # Sprawdzenie, czy jest link do następnej strony
            url = json_response.get('nextLink')

        if not all_data:
            print("❌ BŁĄD: API PSE nie zwróciło danych dla tego okresu.")
            return None

        df_ceny_15min = pd.DataFrame(all_data)
        
        # Przetwarzanie danych
        # Poprawka na "godzinę duch" (zmiana czasu) - API zwraca np. "02a:00"
        df_ceny_15min['dtime_cleaned'] = df_ceny_15min['dtime'].str.replace('a', '').str.replace('b', '')
        df_ceny_15min['DateTime'] = pd.to_datetime(df_ceny_15min['dtime_cleaned'], errors='coerce')
        df_ceny_15min['Cena_PLN_kWh'] = df_ceny_15min['rce_pln'] / 1000
        
        # Uśrednianie cen 15-minutowych do cen godzinowych
        # print("   -> Uśrednianie cen do interwałów godzinowych...")
        df_ceny_h = df_ceny_15min.set_index('DateTime').resample('h')['Cena_PLN_kWh'].mean().reset_index()
        
        # Filtrowanie po stronie serwera jest już aktywne, więc ta linia nie jest już potrzebna.
        # df_ceny_h = df_ceny_h[(df_ceny_h['DateTime'] >= pd.to_datetime(start_date)) & (df_ceny_h['DateTime'] < pd.to_datetime(end_date_api))]


        # print("✅ Ceny giełdowe zostały pobrane i uśrednione.")
        return df_ceny_h[['DateTime', 'Cena_PLN_kWh']]

    except requests.exceptions.RequestException as e:
        print(f"❌ BŁĄD: Problem z połączeniem z serwerem PSE. Sprawdź internet. ({e})")
        return None
    except Exception as e:
        print(f"❌ BŁĄD: Nieoczekiwany problem podczas pobierania cen: {e}")
        return None

def oblicz_wartosc_depozytu(df_energia, df_ceny):
    """Łączy dane i oblicza końcową wartość depozytu."""
    # print("Krok 3: Obliczanie wartości depozytu...")
    
    df_polaczone = pd.merge(df_energia, df_ceny, on='DateTime', how='inner')
    df_polaczone['Wartosc_PLN'] = df_polaczone['Energia_kWh'] * df_polaczone['Cena_PLN_kWh']
    
    energia_oddana = df_polaczone[df_polaczone['Energia_kWh'] > 0]
    
    calkowita_wartosc = energia_oddana['Wartosc_PLN'].sum()
    calkowita_energia = energia_oddana['Energia_kWh'].sum()
    
    return calkowita_wartosc, calkowita_energia

def main():
    """Główna funkcja: wyszukuje wszystkie pliki CSV, przetwarza je i na końcu wyświetla posortowane podsumowanie."""
    print("Rozpoczynam przetwarzanie plików...")
    # Wyszukanie wszystkich plików z rozszerzeniem .csv w bieżącym folderze
    pliki_csv = glob.glob('*.csv')
    
    if not pliki_csv:
        print("Nie znaleziono żadnych plików CSV w tym folderze.")
        print("Upewnij się, że skrypt jest w tym samym folderze co Twoje pliki z danymi.")
        return

    print(f"Znaleziono {len(pliki_csv)} plików do przetworzenia.")
    
    wyniki = []

    # Pętla przetwarzająca każdy znaleziony plik
    for nazwa_pliku in pliki_csv:
        df_energia = wczytaj_dane_uzytkownika(nazwa_pliku)
        
        if df_energia is None or df_energia.empty:
            print(f"Pominięto plik {nazwa_pliku} z powodu błędu lub braku danych.")
            continue
            
        start_date = df_energia['DateTime'].min().date()
        end_date = df_energia['DateTime'].max().date()
        
        df_ceny = pobierz_ceny_rynkowe(start_date, end_date)
        
        if df_ceny is None:
            print(f"Nie udało się pobrać cen dla pliku {nazwa_pliku}. Pomijam.")
            continue
            
        wartosc, energia = oblicz_wartosc_depozytu(df_energia, df_ceny)
        
        # Zapisanie wyników do późniejszego wyświetlenia
        wyniki.append({
            'start_date': start_date,
            'nazwa_pliku': nazwa_pliku,
            'miesiac_rok': start_date.strftime('%B %Y').capitalize(),
            'energia': energia,
            'wartosc': wartosc
        })

    # Sortowanie wyników chronologicznie
    wyniki.sort(key=lambda x: x['start_date'])

    # Wyświetlanie podsumowania
    print("\n\n================== PODSUMOWANIE KOŃCOWE ===================")
    if not wyniki:
        print("Nie udało się przetworzyć żadnego pliku.")
    else:
        for wynik in wyniki:
            print("------------------------------------------------------------")
            print(f" Plik: {wynik['nazwa_pliku']}")
            print(f" Miesiąc: {wynik['miesiac_rok']}")
            print(f" Całkowita energia oddana do sieci: {wynik['energia']:.3f} kWh")
            print(f" Obliczona wartość depozytu: {wynik['wartosc']:.2f} PLN")
    print("============================================================")
    print("\nZakończono przetwarzanie wszystkich plików.")

if __name__ == "__main__":
    main()