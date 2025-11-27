import { COUNTRIES, isEurope } from "./countries.js";

// Continent/region groupings used by the simple shipping preset.
const EUROPE = COUNTRIES.filter((c) => isEurope(c.code)).map((c) => c.code);

const ASIA = [
  "AF","AM","AZ","BH","BD","BT","BN","KH","CN","CX","CC","GE","HK","IN","ID","IR","IQ","IL","JP","JO",
  "KZ","KW","KG","LA","LB","MO","MY","MV","MN","MM","NP","KP","KR","OM","PK","PS","PH","QA","SA","SG",
  "LK","SY","TW","TJ","TH","TL","TR","TM","AE","UZ","VN","YE","RU"
];

const NORTH_AMERICA = [
  "AI","AG","AW","BS","BB","BZ","BM","CA","KY","CR","CU","CW","DM","DO","SV","GL","GD","GP","GT","HT","HN",
  "JM","MQ","MX","MS","NI","PA","PR","BL","KN","LC","MF","PM","VC","SX","TT","TC","US","VG","VI","BQ","UM"
];

const SOUTH_AMERICA = [
  "AR","BO","BR","CL","CO","EC","FK","GF","GY","PY","PE","SR","UY","VE"
];

const OCEANIA = [
  "AS","AU","CK","FJ","PF","GU","KI","MH","FM","NR","NC","NZ","NU","NF","MP","PW","PG","PN","WS","SB","TK",
  "TO","TV","UM","VU","WF"
];

const AFRICA = [
  "DZ","AO","BJ","BW","IO","BF","BI","CV","CM","CF","TD","KM","CG","CD","CI","DJ","EG","GQ","ER","SZ","ET",
  "GA","GM","GH","GN","GW","KE","LS","LR","LY","MG","MW","ML","MR","MU","YT","MA","MZ","NA","NE","NG","RE",
  "RW","SH","ST","SN","SC","SL","SO","ZA","SS","SD","TZ","TG","TN","UG","EH","ZM","ZW"
];

const MIDDLE_EAST = [
  "AE","BH","IQ","IR","IL","JO","KW","LB","OM","PS","QA","SA","SY","TR","YE","CY","EG"
];

export const CONTINENT_GROUPS = [
  { key: "EU", label: "Europe", countries: EUROPE },
  { key: "AS", label: "Asia", countries: ASIA },
  { key: "NA", label: "North America", countries: NORTH_AMERICA },
  { key: "SA", label: "South America", countries: SOUTH_AMERICA },
  { key: "OC", label: "Oceania", countries: OCEANIA },
  { key: "AF", label: "Africa", countries: AFRICA },
  { key: "ME", label: "Middle East", countries: MIDDLE_EAST }
];
