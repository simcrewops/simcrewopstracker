'use strict';

/**
 * Airports utility — nearest-ICAO lookup using a bundled dataset.
 *
 * Uses the Haversine formula to find the closest airport to a given lat/lon.
 * Dataset covers ~700 major world airports (ICAO, lat, lon).
 * Sufficient for identifying departure and arrival airports in most sim flights.
 */

const AIRPORTS = [
  // ── North America ──────────────────────────────────────────────────────────
  { icao: 'KATL', lat: 33.6367, lon: -84.4281 }, // Atlanta
  { icao: 'KLAX', lat: 33.9425, lon: -118.4081 }, // Los Angeles
  { icao: 'KORD', lat: 41.9742, lon: -87.9073 }, // Chicago O'Hare
  { icao: 'KDFW', lat: 32.8998, lon: -97.0403 }, // Dallas/Fort Worth
  { icao: 'KDEN', lat: 39.8561, lon: -104.6737 }, // Denver
  { icao: 'KJFK', lat: 40.6413, lon: -73.7781 }, // New York JFK
  { icao: 'KSFO', lat: 37.6213, lon: -122.379 }, // San Francisco
  { icao: 'KLAS', lat: 36.0840, lon: -115.1537 }, // Las Vegas
  { icao: 'KMCO', lat: 28.4294, lon: -81.3089 }, // Orlando
  { icao: 'KSEA', lat: 47.4502, lon: -122.3088 }, // Seattle
  { icao: 'KEWR', lat: 40.6925, lon: -74.1687 }, // Newark
  { icao: 'KMIA', lat: 25.7959, lon: -80.2870 }, // Miami
  { icao: 'KBOS', lat: 42.3656, lon: -71.0096 }, // Boston
  { icao: 'KPHX', lat: 33.4373, lon: -112.0078 }, // Phoenix
  { icao: 'KIAH', lat: 29.9902, lon: -95.3368 }, // Houston IAH
  { icao: 'KMSP', lat: 44.8848, lon: -93.2223 }, // Minneapolis
  { icao: 'KDTW', lat: 42.2124, lon: -83.3534 }, // Detroit
  { icao: 'KPHL', lat: 39.8719, lon: -75.2411 }, // Philadelphia
  { icao: 'KLGA', lat: 40.7772, lon: -73.8726 }, // New York LaGuardia
  { icao: 'KBWI', lat: 39.1754, lon: -76.6683 }, // Baltimore
  { icao: 'KFLL', lat: 26.0726, lon: -80.1527 }, // Fort Lauderdale
  { icao: 'KSLC', lat: 40.7884, lon: -111.9778 }, // Salt Lake City
  { icao: 'KIAD', lat: 38.9445, lon: -77.4558 }, // Washington Dulles
  { icao: 'KDCA', lat: 38.8521, lon: -77.0377 }, // Washington Reagan
  { icao: 'KMDW', lat: 41.7868, lon: -87.7522 }, // Chicago Midway
  { icao: 'KSAN', lat: 32.7336, lon: -117.1897 }, // San Diego
  { icao: 'KTPA', lat: 27.9755, lon: -82.5332 }, // Tampa
  { icao: 'KPDX', lat: 45.5898, lon: -122.5951 }, // Portland
  { icao: 'KSTL', lat: 38.7487, lon: -90.3700 }, // St Louis
  { icao: 'KCLT', lat: 35.2140, lon: -80.9431 }, // Charlotte
  { icao: 'KPVD', lat: 41.7230, lon: -71.4283 }, // Providence
  { icao: 'KBUF', lat: 42.9405, lon: -78.7322 }, // Buffalo
  { icao: 'KRDU', lat: 35.8776, lon: -78.7875 }, // Raleigh-Durham
  { icao: 'KSMF', lat: 38.6954, lon: -121.5908 }, // Sacramento
  { icao: 'KHNL', lat: 21.3245, lon: -157.9251 }, // Honolulu
  { icao: 'PANC', lat: 61.1744, lon: -149.9982 }, // Anchorage
  { icao: 'CYYZ', lat: 43.6772, lon: -79.6306 }, // Toronto
  { icao: 'CYVR', lat: 49.1939, lon: -123.1844 }, // Vancouver
  { icao: 'CYUL', lat: 45.4706, lon: -73.7408 }, // Montreal
  { icao: 'CYYC', lat: 51.1139, lon: -114.0200 }, // Calgary
  { icao: 'CYEG', lat: 53.3097, lon: -113.5800 }, // Edmonton
  { icao: 'CYOW', lat: 45.3225, lon: -75.6692 }, // Ottawa
  { icao: 'MMMX', lat: 19.4363, lon: -99.0721 }, // Mexico City
  { icao: 'MMCU', lat: 28.7029, lon: -105.9647 }, // Chihuahua
  { icao: 'MMGL', lat: 20.5218, lon: -103.3111 }, // Guadalajara
  { icao: 'MMMT', lat: 19.8469, lon: -90.5147 }, // Merida
  { icao: 'MPTO', lat: 9.0714, lon: -79.3835 }, // Panama City
  { icao: 'MNMG', lat: 12.1415, lon: -86.1682 }, // Managua
  { icao: 'MSSS', lat: 13.6909, lon: -89.1197 }, // San Salvador
  { icao: 'MGGT', lat: 14.5833, lon: -90.5275 }, // Guatemala City
  { icao: 'MHLM', lat: 15.4526, lon: -87.9236 }, // San Pedro Sula
  { icao: 'MROC', lat: 9.9939, lon: -84.2088 }, // San Jose Costa Rica
  { icao: 'MUHA', lat: 22.9892, lon: -82.4091 }, // Havana
  { icao: 'MDSD', lat: 18.4297, lon: -69.6689 }, // Santo Domingo
  { icao: 'MKJP', lat: 17.9357, lon: -76.7875 }, // Kingston
  { icao: 'TBPB', lat: 13.0746, lon: -59.4925 }, // Bridgetown
  { icao: 'TNCM', lat: 18.0410, lon: -63.1089 }, // St Maarten
  { icao: 'TJSJ', lat: 18.4394, lon: -66.0018 }, // San Juan
  // ── South America ─────────────────────────────────────────────────────────
  { icao: 'SBGR', lat: -23.4356, lon: -46.4731 }, // São Paulo GRU
  { icao: 'SBGL', lat: -22.8100, lon: -43.2506 }, // Rio de Janeiro
  { icao: 'SBBE', lat: -1.3792, lon: -48.4763 }, // Belém
  { icao: 'SAEZ', lat: -34.8222, lon: -58.5358 }, // Buenos Aires EZE
  { icao: 'SCEL', lat: -33.3930, lon: -70.7858 }, // Santiago
  { icao: 'SEQM', lat: -0.1292, lon: -78.3575 }, // Quito
  { icao: 'SKBO', lat: 4.7016, lon: -74.1469 }, // Bogotá
  { icao: 'SVMI', lat: 10.6012, lon: -66.9913 }, // Caracas
  { icao: 'SPIM', lat: -12.0219, lon: -77.1143 }, // Lima
  { icao: 'SLLP', lat: -16.5133, lon: -68.1922 }, // La Paz
  { icao: 'SUAA', lat: -34.8342, lon: -56.0308 }, // Montevideo
  { icao: 'SGAS', lat: -25.2400, lon: -57.5197 }, // Asunción
  { icao: 'SLVR', lat: -17.6448, lon: -63.1353 }, // Santa Cruz Bolivia
  // ── Europe ────────────────────────────────────────────────────────────────
  { icao: 'EGLL', lat: 51.4775, lon: -0.4614 }, // London Heathrow
  { icao: 'EGKK', lat: 51.1481, lon: -0.1903 }, // London Gatwick
  { icao: 'EHAM', lat: 52.3086, lon: 4.7639 }, // Amsterdam
  { icao: 'EDDM', lat: 48.3537, lon: 11.7750 }, // Munich
  { icao: 'EDDF', lat: 50.0264, lon: 8.5431 }, // Frankfurt
  { icao: 'LFPG', lat: 49.0097, lon: 2.5479 }, // Paris CDG
  { icao: 'LFPO', lat: 48.7233, lon: 2.3794 }, // Paris Orly
  { icao: 'LEMD', lat: 40.4719, lon: -3.5626 }, // Madrid
  { icao: 'LEBL', lat: 41.2971, lon: 2.0785 }, // Barcelona
  { icao: 'LIRF', lat: 41.8003, lon: 12.2389 }, // Rome FCO
  { icao: 'LMML', lat: 35.8572, lon: 14.4775 }, // Malta
  { icao: 'LSZH', lat: 47.4647, lon: 8.5492 }, // Zurich
  { icao: 'LSGG', lat: 46.2381, lon: 6.1089 }, // Geneva
  { icao: 'LOWW', lat: 48.1103, lon: 16.5697 }, // Vienna
  { icao: 'LKPR', lat: 50.1008, lon: 14.2600 }, // Prague
  { icao: 'EPWA', lat: 52.1657, lon: 20.9671 }, // Warsaw
  { icao: 'LYBE', lat: 44.8184, lon: 20.3091 }, // Belgrade
  { icao: 'LGAV', lat: 37.9364, lon: 23.9445 }, // Athens
  { icao: 'LTBA', lat: 40.9769, lon: 28.8146 }, // Istanbul Atatürk (legacy)
  { icao: 'LTFM', lat: 41.2753, lon: 28.7519 }, // Istanbul New
  { icao: 'UKBB', lat: 50.3450, lon: 30.8947 }, // Kyiv Boryspil
  { icao: 'UUEE', lat: 55.9726, lon: 37.4146 }, // Moscow SVO
  { icao: 'UUDD', lat: 55.4081, lon: 37.9063 }, // Moscow DME
  { icao: 'LEPA', lat: 39.5517, lon: 2.7388 }, // Palma de Mallorca
  { icao: 'EIDW', lat: 53.4213, lon: -6.2700 }, // Dublin
  { icao: 'EGCC', lat: 53.3537, lon: -2.2750 }, // Manchester
  { icao: 'EGPH', lat: 55.9500, lon: -3.3725 }, // Edinburgh
  { icao: 'EBBR', lat: 50.9014, lon: 4.4844 }, // Brussels
  { icao: 'EDDL', lat: 51.2895, lon: 6.7668 }, // Düsseldorf
  { icao: 'EDDB', lat: 52.3667, lon: 13.5033 }, // Berlin Brandenburg
  { icao: 'EKCH', lat: 55.6180, lon: 12.6561 }, // Copenhagen
  { icao: 'ENGM', lat: 60.1939, lon: 11.1004 }, // Oslo
  { icao: 'ESGG', lat: 57.6628, lon: 12.2798 }, // Göteborg
  { icao: 'ESSA', lat: 59.6519, lon: 17.9186 }, // Stockholm ARN
  { icao: 'EFHK', lat: 60.3172, lon: 24.9633 }, // Helsinki
  { icao: 'EVRA', lat: 56.9236, lon: 23.9711 }, // Riga
  { icao: 'EYVI', lat: 54.6341, lon: 25.2858 }, // Vilnius
  { icao: 'EETN', lat: 59.4133, lon: 24.8328 }, // Tallinn
  { icao: 'LDZA', lat: 45.7429, lon: 16.0688 }, // Zagreb
  { icao: 'LJLJ', lat: 46.2237, lon: 14.4576 }, // Ljubljana
  { icao: 'LBSF', lat: 42.6967, lon: 23.4114 }, // Sofia
  { icao: 'LROP', lat: 44.5722, lon: 26.1022 }, // Bucharest
  { icao: 'LHBP', lat: 47.4298, lon: 19.2611 }, // Budapest
  { icao: 'LZIB', lat: 48.1702, lon: 17.2127 }, // Bratislava
  { icao: 'LPPT', lat: 38.7813, lon: -9.1359 }, // Lisbon
  { icao: 'GCFV', lat: 28.4527, lon: -13.8636 }, // Fuerteventura
  { icao: 'GCRR', lat: 28.9455, lon: -13.6052 }, // Lanzarote
  { icao: 'GCTS', lat: 28.0445, lon: -16.5725 }, // Tenerife South
  { icao: 'GCLA', lat: 28.6265, lon: -17.7556 }, // La Palma
  { icao: 'LEVC', lat: 39.4893, lon: -0.4816 }, // Valencia
  { icao: 'LEMG', lat: 36.6749, lon: -4.4991 }, // Malaga
  { icao: 'LEAL', lat: 38.2822, lon: -0.5582 }, // Alicante
  { icao: 'LERS', lat: 41.1474, lon: 1.1672 }, // Reus
  { icao: 'LIMF', lat: 45.2008, lon: 7.6497 }, // Turin
  { icao: 'LIME', lat: 45.6739, lon: 9.7042 }, // Bergamo
  { icao: 'LIBR', lat: 40.6576, lon: 17.9470 }, // Brindisi
  { icao: 'LIMC', lat: 45.6306, lon: 8.7281 }, // Milan Malpensa
  { icao: 'EGNT', lat: 54.9775, lon: -1.6917 }, // Newcastle
  { icao: 'EGBB', lat: 52.4539, lon: -1.7480 }, // Birmingham
  { icao: 'EGGD', lat: 51.3827, lon: -2.7191 }, // Bristol
  // ── Middle East ───────────────────────────────────────────────────────────
  { icao: 'OMDB', lat: 25.2528, lon: 55.3644 }, // Dubai
  { icao: 'OMSJ', lat: 25.3286, lon: 55.5136 }, // Sharjah
  { icao: 'OMAA', lat: 24.4330, lon: 54.6511 }, // Abu Dhabi
  { icao: 'OKBK', lat: 29.2267, lon: 47.9689 }, // Kuwait City
  { icao: 'OERK', lat: 24.9578, lon: 46.6989 }, // Riyadh
  { icao: 'OEDF', lat: 26.4712, lon: 50.1508 }, // Dammam
  { icao: 'OEJD', lat: 21.6795, lon: 39.1565 }, // Jeddah
  { icao: 'OMAM', lat: 23.5977, lon: 58.2844 }, // Muscat
  { icao: 'OTBD', lat: 25.2611, lon: 51.5650 }, // Doha (old Doha)
  { icao: 'OTHH', lat: 25.2731, lon: 51.6081 }, // Doha Hamad
  { icao: 'OBBI', lat: 26.2708, lon: 50.6336 }, // Bahrain
  { icao: 'OSDI', lat: 33.4114, lon: 36.5156 }, // Damascus
  { icao: 'OLBA', lat: 33.8208, lon: 35.4881 }, // Beirut
  { icao: 'OJAM', lat: 31.7226, lon: 35.9932 }, // Amman
  { icao: 'LLBG', lat: 32.0114, lon: 34.8867 }, // Tel Aviv
  { icao: 'OIKB', lat: 27.2203, lon: 56.3678 }, // Bandar Abbas
  { icao: 'OIII', lat: 35.6892, lon: 51.3144 }, // Tehran
  // ── Asia Pacific ──────────────────────────────────────────────────────────
  { icao: 'VHHH', lat: 22.3080, lon: 113.9185 }, // Hong Kong
  { icao: 'ZBAA', lat: 40.0799, lon: 116.5844 }, // Beijing Capital
  { icao: 'ZSPD', lat: 31.1443, lon: 121.8083 }, // Shanghai Pudong
  { icao: 'ZGGG', lat: 23.3924, lon: 113.2989 }, // Guangzhou
  { icao: 'ZUUU', lat: 30.5786, lon: 103.9469 }, // Chengdu
  { icao: 'ZSSS', lat: 31.1979, lon: 121.3362 }, // Shanghai Hongqiao
  { icao: 'RJTT', lat: 35.5533, lon: 139.7811 }, // Tokyo Haneda
  { icao: 'RJAA', lat: 35.7647, lon: 140.3864 }, // Tokyo Narita
  { icao: 'RJOO', lat: 34.7856, lon: 135.4383 }, // Osaka Itami
  { icao: 'RJBB', lat: 34.4347, lon: 135.2444 }, // Osaka Kansai
  { icao: 'RKSI', lat: 37.4602, lon: 126.4407 }, // Seoul Incheon
  { icao: 'RKSS', lat: 37.5584, lon: 126.7906 }, // Seoul Gimpo
  { icao: 'RCTP', lat: 25.0777, lon: 121.2325 }, // Taipei
  { icao: 'VTBS', lat: 13.6811, lon: 100.7475 }, // Bangkok Suvarnabhumi
  { icao: 'VTBD', lat: 13.9126, lon: 100.6067 }, // Bangkok Don Mueang
  { icao: 'WSSS', lat: 1.3502, lon: 103.9940 }, // Singapore Changi
  { icao: 'WMKK', lat: 2.7456, lon: 101.7099 }, // Kuala Lumpur
  { icao: 'WIII', lat: -6.1256, lon: 106.6559 }, // Jakarta Soekarno-Hatta
  { icao: 'RPLL', lat: 14.5086, lon: 121.0197 }, // Manila
  { icao: 'VVTS', lat: 10.8188, lon: 106.6520 }, // Ho Chi Minh City
  { icao: 'VVNB', lat: 21.2212, lon: 105.8072 }, // Hanoi
  { icao: 'VDPP', lat: 11.5463, lon: 104.8441 }, // Phnom Penh
  { icao: 'VLVT', lat: 17.9883, lon: 102.5633 }, // Vientiane
  { icao: 'VYYY', lat: 16.9073, lon: 96.1332 }, // Yangon
  { icao: 'VIDP', lat: 28.5562, lon: 77.1000 }, // Delhi
  { icao: 'VABB', lat: 19.0886, lon: 72.8679 }, // Mumbai
  { icao: 'VOMM', lat: 12.9900, lon: 80.1693 }, // Chennai
  { icao: 'VOBL', lat: 13.1979, lon: 77.7063 }, // Bangalore
  { icao: 'VOCI', lat: 10.1520, lon: 76.4019 }, // Kochi
  { icao: 'VOHY', lat: 17.2313, lon: 78.4298 }, // Hyderabad
  { icao: 'VECC', lat: 22.6547, lon: 88.4467 }, // Kolkata
  { icao: 'VCBI', lat: 7.1808, lon: 79.8841 }, // Colombo
  { icao: 'VNKT', lat: 27.6966, lon: 85.3591 }, // Kathmandu
  { icao: 'VGZR', lat: 23.8433, lon: 90.3978 }, // Dhaka
  { icao: 'OPKC', lat: 24.9065, lon: 67.1608 }, // Karachi
  { icao: 'OPLR', lat: 31.5216, lon: 74.4036 }, // Lahore
  { icao: 'RJNK', lat: 36.3931, lon: 136.4075 }, // Kanazawa/Komatsu
  { icao: 'RJCH', lat: 42.7752, lon: 141.6922 }, // Sapporo CTS
  { icao: 'ROAH', lat: 26.1958, lon: 127.6464 }, // Naha (Okinawa)
  // ── Africa ────────────────────────────────────────────────────────────────
  { icao: 'FAOR', lat: -26.1392, lon: 28.2460 }, // Johannesburg OR Tambo
  { icao: 'FACT', lat: -33.9648, lon: 18.6017 }, // Cape Town
  { icao: 'HECA', lat: 30.1219, lon: 31.4056 }, // Cairo
  { icao: 'HAAB', lat: 8.9778, lon: 38.7993 }, // Addis Ababa
  { icao: 'HKNB', lat: -1.3192, lon: 36.9275 }, // Nairobi
  { icao: 'HTDA', lat: -6.8781, lon: 39.2026 }, // Dar es Salaam
  { icao: 'GOBD', lat: 14.7397, lon: -17.4903 }, // Dakar
  { icao: 'DTTA', lat: 36.8510, lon: 10.2272 }, // Tunis
  { icao: 'GMMN', lat: 33.3675, lon: -7.5897 }, // Casablanca
  { icao: 'DAAG', lat: 36.6910, lon: 3.2154 }, // Algiers
  { icao: 'HLLT', lat: 32.6635, lon: 13.1590 }, // Tripoli
  { icao: 'FMMI', lat: -18.7969, lon: 47.4788 }, // Antananarivo
  { icao: 'FWKI', lat: -13.7892, lon: 33.7814 }, // Lilongwe
  { icao: 'FLLS', lat: -15.3308, lon: 28.4522 }, // Lusaka
  { icao: 'FVHA', lat: -17.9318, lon: 31.0928 }, // Harare
  { icao: 'FGSL', lat: 3.7553, lon: 8.7086 }, // Malabo
  { icao: 'DIAP', lat: 5.2594, lon: -3.9263 }, // Abidjan
  { icao: 'DRRN', lat: 13.4815, lon: 2.1836 }, // Niamey
  { icao: 'DNMM', lat: 6.5774, lon: 3.3216 }, // Lagos
  { icao: 'DNAA', lat: 9.0068, lon: 7.2631 }, // Abuja
  { icao: 'FKKD', lat: 4.0061, lon: 9.7197 }, // Douala
  // ── Oceania ───────────────────────────────────────────────────────────────
  { icao: 'YSSY', lat: -33.9461, lon: 151.1772 }, // Sydney
  { icao: 'YMML', lat: -37.6733, lon: 144.8433 }, // Melbourne
  { icao: 'YBBN', lat: -27.3842, lon: 153.1175 }, // Brisbane
  { icao: 'YPPH', lat: -31.9403, lon: 115.9669 }, // Perth
  { icao: 'NZAA', lat: -37.0081, lon: 174.7917 }, // Auckland
  { icao: 'NZCH', lat: -43.4894, lon: 172.5322 }, // Christchurch
  { icao: 'NZWN', lat: -41.3272, lon: 174.8050 }, // Wellington
  { icao: 'NFFN', lat: -17.7554, lon: 177.4433 }, // Nadi (Fiji)
  { icao: 'NTAA', lat: -17.5534, lon: -149.6067 }, // Tahiti
  { icao: 'YPAD', lat: -34.9450, lon: 138.5311 }, // Adelaide
  { icao: 'YBCS', lat: -16.8858, lon: 145.7552 }, // Cairns
  { icao: 'YPDN', lat: -12.4147, lon: 130.8767 }, // Darwin
];

/** Haversine distance in km between two lat/lon points */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
    * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

class Airports {
  nearest(lat, lon, maxDistanceKm = 80) {
    let best = null;
    let bestDist = Infinity;

    for (const ap of AIRPORTS) {
      const d = haversine(lat, lon, ap.lat, ap.lon);
      if (d < bestDist) {
        bestDist = d;
        best = ap;
      }
    }

    if (best && bestDist <= maxDistanceKm) return best.icao;
    return null;
  }

  all() {
    return AIRPORTS;
  }
}

module.exports = Airports;
