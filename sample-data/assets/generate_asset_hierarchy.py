"""Generates a fictional three-level asset hierarchy for a water utility, as
extracted from a legacy asset register that was merged from several older
systems over the years, so the same physical asset was entered more than once.

  Level 1  Facility   treatment plants, pump stations, reservoirs
  Level 2  System     process areas within a facility (inlet works, aeration, ...)
  Level 3  Equipment  maintainable items (pumps, motors, valves, analysers, ...)

Outputs:
  ASSET_HIERARCHY.csv  the raw register: one row per record, all text, with
                       duplicates of the same asset under different IDs, names,
                       tags and codes, and broken parent links
  ASSET_GOLDEN.csv     the clean truth: one row per real asset, with its parent
  ASSET_MATCH.csv      which golden asset each raw record is (for matching tests)
  DQ_ISSUES.csv        every injected issue (asset_id, column, issue, detail)

Facility names and site codes follow the fictional Maximo sample in the
repository root (LOCATIONS.csv), so SITE_CODE joins to LOCATIONS.LOCATION.

Usage: python3 generate_asset_hierarchy.py
"""
import csv
import random
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
rng = random.Random(20261024)
issues = []


def log(asset_id, column, issue, detail=""):
    issues.append({"asset_id": asset_id, "column": column, "issue": issue, "detail": detail})


def chance(p):
    return rng.random() < p


# --- reference vocabulary ------------------------------------------------------

# (site code, place, facility type, region, short code, latitude, longitude, commissioned)
FACILITIES = [
    ("ME-WWTP-006", "DUNMORE", "WWTP", "METRO", "DUN", -34.7731, 138.5512, 1978),
    ("ME-WTP-009", "HARTLEY", "WTP", "METRO", "HAR", -34.8835, 138.7341, 1986),
    ("SO-WTP-006", "STIRLING", "WTP", "SOUTH", "STI", -35.0102, 138.7187, 1992),
    ("RE-WWTP-015", "IRONBARK", "WWTP", "REGNL", "IRB", -34.5562, 138.7398, 2004),
    ("RE-WTP-006", "LYNDALE", "WTP", "REGNL", "LYN", -34.4651, 139.0122, 1999),
    ("ME-SPS-001", "ASHFORD", "SPS", "METRO", "ASH", -34.9492, 138.5741, 1971),
    ("NO-SPS-006", "MORPHETT", "SPS", "NORTH", "MOR", -34.7208, 138.6493, 1983),
    ("ME-WPS-003", "TORRENS", "WPS", "METRO", "TOR", -34.8811, 138.6627, 1990),
    ("ME-RES-008", "TORRENS", "RES", "METRO", "TRR", -34.8710, 138.6872, 1965),
]

FACILITY_NAMES = {
    "WWTP": ["{P} Wastewater Treatment Plant", "{P} WWTP", "{P} W.W.T.P.", "{P} Waste Water Treatment Plant",
             "{P} STP", "{P} Wastewater Treatment Plt", "{P} Sewage Treatment Works", "WWTP - {P}"],
    "WTP": ["{P} Water Treatment Plant", "{P} WTP", "{P} W.T.P.", "{P} Water Filtration Plant",
            "{P} Water Treatment Plt", "WTP {P}", "{P} Treatment Plant"],
    "SPS": ["{P} Sewage Pump Station", "{P} SPS", "{P} S.P.S.", "{P} Sewer Pump Stn", "{P} Pump Station (Sewer)",
            "SPS - {P}", "{P} Sewerage Pumping Station"],
    "WPS": ["{P} Water Pump Station", "{P} WPS", "{P} Water Pumping Station", "{P} Booster PS", "{P} W.P.S."],
    "RES": ["{P} Storage Reservoir", "{P} Reservoir", "{P} Res.", "{P} Tank", "{P} Storage Res", "Reservoir - {P}"],
}

# System (level 2) templates per facility type: (canonical name, tag code, name variants, equipment list key)
SYSTEMS = {
    "WWTP": [
        ("Inlet Works", "INL", ["Inlet Works", "INLET WORKS", "Inlet Wks", "Inlet Works & Screening", "Headworks"], "inlet"),
        ("Primary Sedimentation", "PST", ["Primary Sedimentation", "Primary Sed Tanks", "PRIMARY SEDIMENTATION TANKS", "Primary Settling", "PST"], "pst"),
        ("Aeration System", "AER", ["Aeration System", "Aeration", "AERATION TANKS", "Bioreactor - Aeration", "Aeration Sys."], "aeration"),
        ("Secondary Clarifiers", "SCL", ["Secondary Clarifiers", "Sec. Clarifiers", "SECONDARY CLARIFIER", "Clarifiers (Secondary)"], "clarifier"),
        ("UV Disinfection", "UVD", ["UV Disinfection", "UV Disinfection System", "U.V. DISINFECTION", "UV Plant", "Ultraviolet Disinfection"], "uv"),
        ("Sludge Dewatering", "SDW", ["Sludge Dewatering", "Sludge Dewatering Bldg", "DEWATERING", "Biosolids Dewatering", "Sludge Dewatering Facility"], "dewatering"),
        ("Electrical & Control", "ELC", ["Electrical & Control", "Electrical and Controls", "ELEC & CONTROL", "E&C", "Electrical/SCADA"], "electrical"),
    ],
    "WTP": [
        ("Raw Water Intake", "RWI", ["Raw Water Intake", "Raw Water Inlet", "RAW WATER INTAKE", "Intake Structure", "RW Intake"], "intake"),
        ("Coagulation & Flocculation", "CFL", ["Coagulation & Flocculation", "Coag/Floc", "COAGULATION AND FLOCCULATION", "Flocculation Tanks", "Chemical Dosing & Floc"], "floc"),
        ("Filtration", "FLT", ["Filtration", "Filters", "FILTRATION SYSTEM", "Rapid Gravity Filters", "Filter Gallery"], "filtration"),
        ("Chlorine Disinfection", "CLD", ["Chlorine Disinfection", "Chlorination", "CHLORINATION SYSTEM", "Chlorine Dosing", "Disinfection (Cl2)"], "chlorination"),
        ("Treated Water Pumping", "TWP", ["Treated Water Pumping", "Treated Water Pump Station", "TW PUMPING", "Clear Water Pumps", "High Lift Pumps"], "pumpset"),
        ("Electrical & Control", "ELC", ["Electrical & Control", "Electrical and Controls", "ELEC & CONTROL", "E&C", "Electrical/SCADA"], "electrical"),
    ],
    "SPS": [
        ("Wet Well", "WWL", ["Wet Well", "Wetwell", "WET WELL", "Pump Well", "Wet Well & Inlet"], "wetwell"),
        ("Pump Set", "PMP", ["Pump Set", "Pumps", "PUMP SET", "Pumping Units", "Duty/Standby Pumps"], "sewerpumps"),
        ("Valve Pit", "VLV", ["Valve Pit", "Valve Chamber", "VALVE PIT", "Valve Pit & Rising Main"], "valvepit"),
        ("Electrical & Control", "ELC", ["Electrical & Control", "Electrical and Controls", "ELEC & CONTROL", "Switchroom", "Electrical/SCADA"], "electrical_small"),
    ],
    "WPS": [
        ("Pump Set", "PMP", ["Pump Set", "Pumps", "PUMP SET", "Booster Pumps", "Pumping Units"], "pumpset"),
        ("Suction & Delivery Valves", "VLV", ["Suction & Delivery Valves", "Valves", "SUCTION/DELIVERY VALVES", "Valve Manifold"], "valves"),
        ("Electrical & Control", "ELC", ["Electrical & Control", "Electrical and Controls", "ELEC & CONTROL", "Switchroom", "Electrical/SCADA"], "electrical_small"),
    ],
    "RES": [
        ("Storage Tank", "TNK", ["Storage Tank", "Tank", "RESERVOIR TANK", "Storage Tank (Concrete)", "Main Tank"], "tank"),
        ("Inlet & Outlet Valves", "VLV", ["Inlet & Outlet Valves", "Inlet/Outlet Valves", "INLET OUTLET VALVES", "Valve House"], "resvalves"),
        ("Water Quality Monitoring", "WQM", ["Water Quality Monitoring", "WQ Monitoring", "WATER QUALITY", "Rechlorination & WQ", "WQ Analysers"], "wq"),
    ],
}

# Manufacturers: canonical name first, then the ways people typed it.
MAKERS = {
    "Flygt": ["Flygt", "FLYGT", "Xylem Flygt", "ITT Flygt", "Fligt", "XYLEM"],
    "Grundfos": ["Grundfos", "GRUNDFOS", "Grundfoss", "Grunfos", "Grundfos Pumps Pty Ltd"],
    "KSB": ["KSB", "K.S.B.", "KSB Australia", "Ksb"],
    "ABB": ["ABB", "A.B.B.", "Asea Brown Boveri", "abb"],
    "WEG": ["WEG", "Weg", "W.E.G.", "WEG Australia"],
    "Danfoss": ["Danfoss", "DANFOSS", "Danfos", "Danfoss VLT"],
    "Siemens": ["Siemens", "SIEMENS", "Siemans", "Siemens Ltd"],
    "Endress+Hauser": ["Endress+Hauser", "Endress & Hauser", "E+H", "ENDRESS HAUSER", "Endress Hauser"],
    "Krohne": ["Krohne", "KROHNE", "Krone"],
    "AVK": ["AVK", "A.V.K.", "AVK Valves"],
    "Keystone": ["Keystone", "Tyco Keystone", "KEYSTONE", "Emerson Keystone"],
    "Aerzen": ["Aerzen", "AERZEN", "Aerzener"],
    "Evoqua": ["Evoqua", "Wallace & Tiernan", "W&T", "Evoqua W&T", "Wallace and Tiernan"],
    "Trojan": ["Trojan", "Trojan UV", "TROJAN TECHNOLOGIES", "Trojen"],
    "Hach": ["Hach", "HACH", "Hach Lange"],
    "Schneider Electric": ["Schneider Electric", "Schneider", "SCHNEIDER", "Square D"],
    "Huber": ["Huber", "HUBER", "Hans Huber"],
    "Andritz": ["Andritz", "ANDRITZ", "Andriz"],
    "Wilo": ["Wilo", "WILO", "Wilo-EMU"],
    "Kingfisher": ["Kingfisher", "Schneider Kingfisher", "Kingfisher RTU", "KINGFISHER"],
    "Vega": ["Vega", "VEGA", "Vegapuls"],
}

# Equipment (level 3): (name, tag code, class, quantity, makers, models, rating)
EQUIPMENT = {
    "inlet": [("Inlet Screen", "SCR", "MECH\\SCREEN", 2, ["Huber"], ["RoK 4", "Ro 2"], "{n}mm"),
              ("Grit Classifier", "GRC", "MECH\\GRIT", 1, ["Huber"], ["RoSF 4"], "{kw_medium}kW"),
              ("Inlet Flow Meter", "FIT", "METER\\FLOW", 1, ["Endress+Hauser", "Krohne"], ["Promag W 400", "Optiflux 2000"], "DN{dn}")],
    "pst": [("Sludge Scraper Drive", "SCD", "MECH\\SCRAPER", 2, ["Siemens", "WEG"], ["SK 9032", "WG20"], "{kw_small}kW"),
            ("Primary Sludge Pump", "PMP", "PUMP\\CENT", 2, ["KSB", "Grundfos"], ["Amarex KRT", "SE1.80"], "{kw}kW")],
    "aeration": [("Aeration Blower", "BLW", "MECH\\BLOWER", 3, ["Aerzen"], ["Delta Hybrid D62S", "GM 35S"], "{kw}kW"),
                 ("Blower Variable Speed Drive", "VSD", "VSD", 3, ["ABB", "Danfoss"], ["ACS880", "VLT AQUA FC202"], "{kw}kW"),
                 ("Dissolved Oxygen Analyser", "DOA", "INSTR\\ANALYSER", 2, ["Hach"], ["LDO sc"], ""),
                 ("Anoxic Zone Mixer", "MIX", "MECH\\MIXER", 2, ["Flygt", "Wilo"], ["4650", "TR 216"], "{kw_medium}kW")],
    "clarifier": [("Clarifier Bridge Drive", "CBD", "MECH\\SCRAPER", 2, ["Siemens"], ["SK 9042"], "{kw_small}kW"),
                  ("Return Activated Sludge Pump", "RAS", "PUMP\\SUB", 2, ["Flygt"], ["NP 3153", "NP 3171"], "{kw}kW")],
    "uv": [("UV Reactor Bank", "UVR", "TREAT\\UV", 2, ["Trojan"], ["UV3000Plus", "UVSigna"], "{mld} ML/d"),
           ("UV Transmittance Analyser", "UVT", "INSTR\\ANALYSER", 1, ["Hach", "Trojan"], ["UVAS sc", "OptiView"], "")],
    "dewatering": [("Dewatering Centrifuge", "CEN", "MECH\\CENTRIFUGE", 2, ["Andritz"], ["D5LL"], "{kw}kW"),
                   ("Polymer Dosing Pump", "PDP", "PUMP\\DOSING", 2, ["Grundfos"], ["DDA 60-10"], "{kw_small}kW")],
    "electrical": [("Main Switchboard", "MSB", "ELEC\\SWBD", 1, ["Schneider Electric", "ABB"], ["Prisma P", "MNS"], "{amps}A"),
                   ("SCADA RTU", "RTU", "SCADA\\RTU", 1, ["Kingfisher", "Schneider Electric"], ["PC-1", "SCADAPack 470"], "")],
    "electrical_small": [("Pump Control Cabinet", "PCC", "ELEC\\SWBD", 1, ["Schneider Electric", "ABB"], ["Prisma G", "ArTu"], "{amps}A"),
                         ("SCADA RTU", "RTU", "SCADA\\RTU", 1, ["Kingfisher"], ["PC-1", "Series 3"], "")],
    "intake": [("Raw Water Pump", "PMP", "PUMP\\CENT", 2, ["KSB", "Grundfos"], ["Omega 300-560", "HS 250-500"], "{kw}kW"),
               ("Intake Isolation Valve", "VLV", "VALVE\\BFLY", 2, ["Keystone", "AVK"], ["Fig 990", "Series 75"], "DN{dn}"),
               ("Raw Water Turbidity Analyser", "TUR", "INSTR\\ANALYSER", 1, ["Hach"], ["TU5300 sc"], "")],
    "floc": [("Alum Dosing Pump", "ADP", "PUMP\\DOSING", 2, ["Grundfos"], ["DDA 120-7"], "{kw_small}kW"),
             ("Flocculator Mixer", "MIX", "MECH\\MIXER", 3, ["Wilo", "Flygt"], ["TR 326", "4620"], "{kw_medium}kW")],
    "filtration": [("Filter Inlet Valve", "FIV", "VALVE\\BFLY", 4, ["Keystone"], ["Fig 990"], "DN{dn}"),
                   ("Backwash Pump", "BWP", "PUMP\\CENT", 2, ["KSB"], ["Etanorm 150-400"], "{kw}kW"),
                   ("Filtered Water Turbidity Analyser", "TUR", "INSTR\\ANALYSER", 2, ["Hach"], ["TU5400 sc"], "")],
    "chlorination": [("Gas Chlorinator", "CHL", "TREAT\\CHLOR", 2, ["Evoqua"], ["V10K", "S10K"], "{kgh} kg/h"),
                     ("Chlorine Residual Analyser", "CLA", "INSTR\\ANALYSER", 2, ["Hach", "Endress+Hauser"], ["CL17sc", "CCS51D"], "")],
    "pumpset": [("Duty Pump", "PMP", "PUMP\\CENT", 3, ["KSB", "Grundfos"], ["Omega 200-520", "NKG 200-150-400"], "{kw}kW"),
                ("Pump Motor", "MTR", "MOTOR\\LV", 3, ["WEG", "ABB"], ["W22 315", "M3BP 315"], "{kw}kW"),
                ("Pump Variable Speed Drive", "VSD", "VSD", 3, ["ABB", "Danfoss"], ["ACQ580", "VLT AQUA FC202"], "{kw}kW"),
                ("Delivery Flow Meter", "FIT", "METER\\FLOW", 1, ["Krohne", "Endress+Hauser"], ["Optiflux 2000", "Promag W 400"], "DN{dn}")],
    "wetwell": [("Wet Well Level Sensor", "LIT", "INSTR\\LEVEL", 2, ["Vega", "Endress+Hauser"], ["VEGAPULS C 21", "FMR20"], ""),
                ("Odour Control Fan", "FAN", "MECH\\FAN", 1, ["Siemens"], ["2CC2 512"], "{kw_medium}kW")],
    "sewerpumps": [("Submersible Pump", "PMP", "PUMP\\SUB", 2, ["Flygt", "Grundfos"], ["NP 3127", "NP 3153", "SE1.110"], "{kw}kW"),
                   ("Pump Variable Speed Drive", "VSD", "VSD", 2, ["Danfoss", "ABB"], ["VLT AQUA FC202", "ACQ580"], "{kw}kW")],
    "valvepit": [("Non-Return Valve", "NRV", "VALVE\\CHECK", 2, ["AVK"], ["Series 41"], "DN{dn}"),
                 ("Isolation Gate Valve", "GV", "VALVE\\GATE", 2, ["AVK"], ["Series 06/30"], "DN{dn}"),
                 ("Rising Main Flow Meter", "FIT", "METER\\FLOW", 1, ["Krohne"], ["Optiflux 2000"], "DN{dn}")],
    "valves": [("Suction Isolation Valve", "SV", "VALVE\\BFLY", 3, ["Keystone", "AVK"], ["Fig 990", "Series 75"], "DN{dn}"),
               ("Delivery Check Valve", "NRV", "VALVE\\CHECK", 3, ["AVK"], ["Series 41"], "DN{dn}")],
    "tank": [("Reservoir Structure", "STR", "STRUCT\\TANK", 1, [""], [""], "{ml} ML"),
             ("Reservoir Level Sensor", "LIT", "INSTR\\LEVEL", 1, ["Vega"], ["VEGAPULS 64"], "")],
    "resvalves": [("Inlet Valve", "INV", "VALVE\\BFLY", 1, ["Keystone"], ["Fig 990"], "DN{dn}"),
                  ("Outlet Valve", "OTV", "VALVE\\BFLY", 1, ["Keystone"], ["Fig 990"], "DN{dn}"),
                  ("Scour Valve", "SCV", "VALVE\\GATE", 1, ["AVK"], ["Series 06/30"], "DN{dn}")],
    "wq": [("Chlorine Residual Analyser", "CLA", "INSTR\\ANALYSER", 1, ["Hach"], ["CL17sc"], ""),
           ("Rechlorination Dosing Pump", "DOS", "PUMP\\DOSING", 2, ["Grundfos"], ["DDA 7.5-16"], "{kw_small}kW")],
}

CLASS_VARIANTS = {
    "MECH\\SCREEN": ["MECH/SCREEN", "SCREEN", "Screen", "MECH-SCREEN"],
    "MECH\\GRIT": ["MECH/GRIT", "GRIT CLASSIFIER", "Grit"],
    "METER\\FLOW": ["METER/FLOW", "FLOWMETER", "Flow Meter", "MAG FLOW", "INSTR\\FLOW"],
    "MECH\\SCRAPER": ["MECH/SCRAPER", "SCRAPER", "Scraper Drive"],
    "PUMP\\CENT": ["PUMP/CENT", "CENT PUMP", "Centrifugal Pump", "PUMP-CENT", "PUMP"],
    "PUMP\\SUB": ["PUMP/SUB", "SUB PUMP", "Submersible Pump", "PUMP-SUB", "PUMP"],
    "PUMP\\DOSING": ["PUMP/DOSING", "DOSING PUMP", "Dosing Pump", "PUMP"],
    "MECH\\BLOWER": ["MECH/BLOWER", "BLOWER", "Blower", "Aeration Blower"],
    "VSD": ["V.S.D.", "VFD", "Variable Speed Drive", "DRIVE\\VSD", "ELEC\\VSD"],
    "INSTR\\ANALYSER": ["INSTR/ANALYSER", "ANALYZER", "Analyser", "INSTR\\ANALYZER", "WQ ANALYSER"],
    "INSTR\\LEVEL": ["INSTR/LEVEL", "LEVEL TX", "Level Transmitter", "LIT"],
    "MECH\\MIXER": ["MECH/MIXER", "MIXER", "Mixer"],
    "TREAT\\UV": ["TREAT/UV", "UV", "UV Unit", "UV REACTOR"],
    "MECH\\CENTRIFUGE": ["MECH/CENTRIFUGE", "CENTRIFUGE", "Decanter Centrifuge"],
    "ELEC\\SWBD": ["ELEC/SWBD", "SWITCHBOARD", "Switchboard", "MSB", "ELEC\\MCC"],
    "SCADA\\RTU": ["SCADA/RTU", "RTU", "Telemetry RTU", "SCADA"],
    "VALVE\\BFLY": ["VALVE/BFLY", "BUTTERFLY VALVE", "Butterfly Valve", "VALVE", "VALVE\\BF"],
    "VALVE\\GATE": ["VALVE/GATE", "GATE VALVE", "Gate Valve", "VALVE", "SLUICE VALVE"],
    "VALVE\\CHECK": ["VALVE/CHECK", "NRV", "Check Valve", "Non Return Valve", "VALVE"],
    "TREAT\\CHLOR": ["TREAT/CHLOR", "CHLORINATOR", "Chlorinator", "CL2"],
    "MOTOR\\LV": ["MOTOR/LV", "MOTOR", "Electric Motor", "LV MOTOR"],
    "MECH\\FAN": ["MECH/FAN", "FAN", "Odour Fan"],
    "STRUCT\\TANK": ["STRUCT/TANK", "TANK", "Reservoir", "STRUCTURE"],
    "FACILITY": ["Facility", "SITE", "PLANT", "FAC"],
    "SYSTEM": ["System", "PROCESS", "PROC AREA", "SYS"],
}

STATUS_VARIANTS = {
    "OPERATING": ["Operating", "OPERATING ", "In Service", "IN SVC", "ACTIVE", "Active", "Op", "OPR"],
    "DECOMMISSIONED": ["Decommissioned", "DECOM", "Removed", "INACTIVE", "Not in use", "Retired"],
}
LEVEL_NAMES = {1: ["L1", "Facility", "Level 1", "1.0", "FAC"], 2: ["L2", "System", "Level 2", "2.0", "PROC"],
               3: ["L3", "Equipment", "Level 3", "3.0", "EQUIP"]}
REGION_VARIANTS = {"METRO": ["Metro", "METROPOLITAN", "MET"], "NORTH": ["North", "NTH", "Northern"],
                   "SOUTH": ["South", "STH", "Southern"], "REGNL": ["Regional", "REGIONAL", "REG"]}
SOURCES = ["HANSEN", "GIS", "SPREADSHEET", "MAXIMO_MIG"]
USERS = ["TPAPADOP", "jnguyen", "MKELLY", "s.oconnor", "RBROWN", "lwilliams", "MIGRATION", "GIS_LOAD", "admin"]
MISSING = ["", "", "", "NULL", "N/A", "-", "TBA", "UNKNOWN", " "]

# --- golden hierarchy ------------------------------------------------------------

golden = []


def add_golden(level, tag, name, cls, parent, fac, **extra):
    g = {
        "golden_id": f"G{len(golden) + 1:04d}",
        "asset_level": level,
        "asset_tag": tag,
        "asset_name": name,
        "asset_class": cls,
        "parent_golden_id": parent["golden_id"] if parent else "",
        "site_code": fac[0],
        "region": fac[3],
        "status": "OPERATING",
        "manufacturer": "",
        "model": "",
        "serial_no": "",
        "install_date": "",
        "criticality": "",
        "rating": "",
        "latitude": "",
        "longitude": "",
        **extra,
    }
    golden.append(g)
    return g


def rating_for(template, cls):
    values = {
        "kw": rng.choice([11, 15, 22, 30, 37, 45, 55, 75, 90, 110, 132, 160]),
        "kw_small": rng.choice([0.37, 0.55, 0.75, 1.1, 1.5, 2.2]),
        "kw_medium": rng.choice([2.2, 3, 4, 5.5, 7.5, 11]),
        "dn": rng.choice([100, 150, 200, 250, 300, 375, 450, 600]),
        "amps": rng.choice([400, 630, 800, 1250, 1600]),
        "mld": rng.choice([20, 45, 60, 90, 120]),
        "kgh": rng.choice([5, 10, 20]),
        "ml": rng.choice([10, 20, 35, 50, 80]),
        "n": rng.choice([3, 6, 10]),
    }
    return template.format(**values) if template else ""


def jitter(v, spread=0.002):
    return round(v + rng.uniform(-spread, spread), 6)


for fac in FACILITIES:
    code, place, ftype, region, short, lat, lon, year = fac
    canonical = FACILITY_NAMES[ftype][0].format(P=place.title())
    f = add_golden(1, f"{short}-{ftype}", canonical, "FACILITY", None, fac,
                   install_date=date(year, rng.randint(1, 12), rng.randint(1, 28)).isoformat(),
                   criticality=str(rng.choice([1, 1, 2])), latitude=lat, longitude=lon)
    f["_type"] = ftype
    systems = SYSTEMS[ftype]
    for sname, scode, svariants, eqkey in systems:
        s = add_golden(2, f"{short}-{scode}", sname, "SYSTEM", f, fac,
                       install_date=date(year + rng.randint(0, 15), rng.randint(1, 12), rng.randint(1, 28)).isoformat(),
                       criticality=str(rng.choice([1, 2, 2, 3])), latitude=jitter(lat), longitude=jitter(lon))
        s["_variants"] = svariants
        for ename, ecode, cls, qty, makers, models, rating in EQUIPMENT[eqkey]:
            for i in range(1, qty + 1):
                maker = rng.choice(makers)
                installed = date(year, 6, 1) + timedelta(days=rng.randint(0, (2024 - year) * 365))
                e = add_golden(
                    3, f"{short}-{scode}-{ecode}-{i:02d}", f"{ename} No. {i}" if qty > 1 else ename, cls, s, fac,
                    manufacturer=maker, model=rng.choice(models) if maker else "",
                    serial_no=f"{rng.choice(['SN', '', 'S/N '])}{rng.randint(10_000_000, 99_999_999)}" if maker else "",
                    install_date=installed.isoformat(), criticality=str(rng.choice([1, 2, 2, 3, 3, 4, 5])),
                    rating=rating_for(rating, cls), latitude=jitter(lat), longitude=jitter(lon),
                )
                e["_base"] = ename
                e["_no"] = i if qty > 1 else None
                # About 5% of equipment has really been taken out of service.
                if chance(0.05):
                    e["status"] = "DECOMMISSIONED"

by_golden = {g["golden_id"]: g for g in golden}

# --- raw register ---------------------------------------------------------------

raw = []
used_ids = set()
records_of = {}  # golden_id -> [raw rows]


def new_id(source):
    while True:
        if source == "HANSEN":
            rid = f"H{rng.randint(1000, 99999):06d}"
        elif source == "GIS":
            rid = f"GIS-{rng.randint(10000, 99999)}"
        elif source == "SPREADSHEET":
            rid = f"SS{rng.randint(100, 9999):04d}"
        else:
            rid = str(rng.randint(200000, 299999))
        if rid not in used_ids:
            used_ids.add(rid)
            return rid


def copies(level):
    """How many records the register holds for one real asset."""
    if level == 1:
        return rng.choices([2, 3, 4], [35, 45, 20])[0]
    if level == 2:
        return rng.choices([1, 2, 3], [35, 45, 20])[0]
    return rng.choices([1, 2, 3, 4], [42, 36, 15, 7])[0]


def name_variant(g):
    level = g["asset_level"]
    if level == 1:
        place = next(f[1] for f in FACILITIES if f[0] == g["site_code"])
        ftype = next(f[2] for f in FACILITIES if f[0] == g["site_code"])
        p = rng.choice([place, place.title(), place.title(), place.capitalize()])
        return rng.choice(FACILITY_NAMES[ftype]).format(P=p)
    if level == 2:
        base = rng.choice(g["_variants"])
        short = g["asset_tag"].split("-")[0]
        place = next(f[1] for f in FACILITIES if f[0] == g["site_code"])
        return rng.choice([base, base, f"{short} {base}", f"{place.title()} - {base}", f"{base} ({place})"])
    base, no = g["_base"], g["_no"]
    words = base.split()
    styles = [
        lambda: g["asset_name"],
        lambda: base.upper() + (f" #{no}" if no else ""),
        lambda: f"{words[-1]} {no}" if no else words[-1],
        lambda: f"{base} {no:02d}" if no else base,
        lambda: f"{words[-1]} No.{no} - {' '.join(words[:-1])}" if no and len(words) > 1 else base.lower(),
        lambda: base.replace("Variable Speed Drive", "VSD").replace("Analyser", "Analyzer").replace("Pump", "Pmp")
        + (f" {no}" if no else ""),
        lambda: f"{base} (Unit {no})" if no else f"{base} - main",
    ]
    return rng.choice(styles)()


def tag_variant(tag):
    style = rng.choice(["nodash", "lower", "short_no", "space", "blank", "old"])
    if style == "nodash":
        return tag.replace("-", "")
    if style == "lower":
        return tag.lower()
    if style == "short_no":
        return tag[:-3] + "-" + str(int(tag[-2:])) if tag[-2:].isdigit() else tag + "-1"
    if style == "space":
        return tag.replace("-", " ")
    if style == "old":
        return "OLD-" + tag
    return ""


def fmt_date(iso, rid):
    if not iso:
        return ""
    d = date.fromisoformat(iso)
    style = rng.choices(["dmy", "iso", "dmon", "year", "excel", "mdy"], [45, 25, 12, 8, 6, 4])[0]
    if style == "dmy":
        return d.strftime("%d/%m/%Y")
    if style == "iso":
        return d.isoformat()
    if style == "dmon":
        log(rid, "INSTALL_DATE", "two_digit_year", iso)
        return d.strftime("%d-%b-%y").upper()
    if style == "year":
        log(rid, "INSTALL_DATE", "year_only", iso)
        return str(d.year)
    if style == "excel":
        log(rid, "INSTALL_DATE", "excel_serial_date", iso)
        return str((d - date(1899, 12, 30)).days)
    if d.day <= 12 and d.day != d.month:
        log(rid, "INSTALL_DATE", "month_day_swapped", iso)
        return d.strftime("%m/%d/%Y")
    return d.strftime("%d/%m/%Y")


def rating_variant(rating, rid):
    if not rating or not rating.endswith("kW"):
        return rating
    kw = rating[:-2]
    style = rng.choice(["space", "upper", "bare", "mw", "lower"])
    out = {"space": f"{kw} kW", "upper": f"{kw}KW", "bare": kw,
           "mw": f"{float(kw) / 1000:g} MW", "lower": f"{kw}kw"}[style]
    log(rid, "RATING", "inconsistent_units", f"{rating} written as {out}")
    return out


def maybe(value, rid, column, variants=None, p=0.0, issue="non_standard_value"):
    """Swaps in a variant (logged) with probability p."""
    if variants and chance(p):
        v = rng.choice(variants)
        if v != value:
            log(rid, column, issue, f"{v!r} for {value!r}")
            return v
    return value


for g in golden:
    n = copies(g["asset_level"])
    rows = []
    sources = rng.sample(SOURCES, k=min(n, len(SOURCES)))
    while len(sources) < n:
        sources.append(rng.choice(SOURCES))
    for k in range(n):
        source = sources[k]
        rid = new_id(source)
        dup = k > 0
        level = g["asset_level"]
        row = {
            "ASSET_ID": rid,
            "ASSET_TAG": g["asset_tag"],
            "ASSET_DESC": g["asset_name"],
            "ASSET_LEVEL": str(level),
            "ASSET_CLASS": g["asset_class"],
            "PARENT_ASSET_ID": "",
            "SITE_CODE": g["site_code"],
            "REGION": g["region"],
            "STATUS": g["status"],
            "MANUFACTURER": g["manufacturer"],
            "MODEL": g["model"],
            "SERIAL_NO": g["serial_no"],
            "INSTALL_DATE": "",
            "CRITICALITY": g["criticality"],
            "RATING": g["rating"],
            "LATITUDE": str(g["latitude"]),
            "LONGITUDE": str(g["longitude"]),
            "SOURCE_SYSTEM": source,
            "CREATED_BY": rng.choice(USERS),
            "CREATED_DATE": (date(2008, 1, 1) + timedelta(days=rng.randint(0, 6200))).strftime("%d/%m/%Y"),
            "COMMENTS": "",
        }
        if dup:
            log(rid, "ASSET_ID", "duplicate_record", f"same asset as {rows[0]['ASSET_ID']} ({g['golden_id']})")
        # Names and tags: every copy after the first is typed differently; first copies drift too.
        if dup or chance(0.35):
            v = name_variant(g)
            if v != g["asset_name"]:
                log(rid, "ASSET_DESC", "name_variant", f"{v!r} for {g['asset_name']!r}")
                row["ASSET_DESC"] = v
        if (dup and chance(0.7)) or chance(0.12):
            v = tag_variant(g["asset_tag"])
            log(rid, "ASSET_TAG", "missing_value" if not v else "tag_variant", f"{v!r} for {g['asset_tag']!r}")
            row["ASSET_TAG"] = v
        row["ASSET_LEVEL"] = maybe(row["ASSET_LEVEL"], rid, "ASSET_LEVEL", LEVEL_NAMES[level], 0.22)
        row["ASSET_CLASS"] = maybe(row["ASSET_CLASS"], rid, "ASSET_CLASS", CLASS_VARIANTS.get(g["asset_class"]), 0.3 if dup else 0.15)
        row["REGION"] = maybe(row["REGION"], rid, "REGION", REGION_VARIANTS[g["region"]], 0.2)
        row["STATUS"] = maybe(row["STATUS"], rid, "STATUS", STATUS_VARIANTS[g["status"]], 0.3)
        if g["manufacturer"]:
            row["MANUFACTURER"] = maybe(g["manufacturer"], rid, "MANUFACTURER", MAKERS[g["manufacturer"]][1:], 0.55 if dup else 0.25)
            if dup and chance(0.35):
                row["MODEL"] = rng.choice([g["model"].upper(), g["model"].replace(" ", ""), g["model"] + " ", ""])
                log(rid, "MODEL", "model_variant", f"{row['MODEL']!r} for {g['model']!r}")
            if dup and chance(0.5):
                digits = "".join(ch for ch in g["serial_no"] if ch.isdigit())
                row["SERIAL_NO"] = rng.choice([digits, f"SN-{digits}", f"sn{digits}", digits[:-1], "TBA", "UNKNOWN", ""])
                log(rid, "SERIAL_NO", "serial_variant", f"{row['SERIAL_NO']!r} for {g['serial_no']!r}")
        row["INSTALL_DATE"] = fmt_date(g["install_date"], rid)
        if dup and chance(0.25) and g["install_date"]:
            other = date.fromisoformat(g["install_date"]) + timedelta(days=rng.choice([-365, 365, 30, -30, 3650]))
            row["INSTALL_DATE"] = other.strftime("%d/%m/%Y")
            log(rid, "INSTALL_DATE", "conflicting_value", f"{other.isoformat()} vs {g['install_date']}")
        if dup and chance(0.3):
            row["CRITICALITY"] = rng.choice(["High", "H", "A", "Med", "Low", "C", str(min(5, int(g["criticality"] or 3) + 1))])
            log(rid, "CRITICALITY", "non_standard_value", f"{row['CRITICALITY']!r} for {g['criticality']!r}")
        if dup and chance(0.5):
            row["RATING"] = rating_variant(g["rating"], rid)
        # A replaced asset: the old copy was decommissioned but the new one never linked.
        if dup and g["status"] == "OPERATING" and chance(0.08):
            row["STATUS"] = rng.choice(STATUS_VARIANTS["DECOMMISSIONED"])
            row["COMMENTS"] = rng.choice(["Replaced - see new asset", "superseded", "REPLACED 2019", "old record?"])
            log(rid, "STATUS", "status_conflict", f"{row['STATUS']!r} while another record of {g['golden_id']} is operating")
        # Coordinates
        if chance(0.04):
            row["LATITUDE"], row["LONGITUDE"] = row["LONGITUDE"], row["LATITUDE"]
            log(rid, "LATITUDE", "lat_long_swapped")
        elif chance(0.03):
            row["LATITUDE"], row["LONGITUDE"] = "0", "0"
            log(rid, "LATITUDE", "zero_coordinates")
        elif chance(0.03):
            row["LATITUDE"] = row["LATITUDE"].lstrip("-")
            log(rid, "LATITUDE", "sign_lost", f"{row['LATITUDE']} should be negative")
        elif source == "SPREADSHEET" and chance(0.4):
            row["LATITUDE"] = row["LONGITUDE"] = ""
            log(rid, "LATITUDE", "missing_value")
        # Blanks and missing-value tokens.
        for column in ("MANUFACTURER", "MODEL", "CRITICALITY", "RATING", "INSTALL_DATE", "SITE_CODE"):
            if row[column] and chance(0.04):
                row[column] = rng.choice(MISSING)
                log(rid, column, "missing_value", repr(row[column]))
        if dup and not row["COMMENTS"] and chance(0.15):
            row["COMMENTS"] = rng.choice([f"dup of {rows[0]['ASSET_ID']}?", "Created from GIS", "check with ops",
                                          "migrated from Hansen", "duplicate? - DO NOT USE", "per site visit 2017"])
        rows.append(row)
    records_of[g["golden_id"]] = rows
    for row in rows:
        row["_golden"] = g["golden_id"]
    raw.extend(rows)

# Parent links: each record points at one of its parent's records, chosen at
# random, so children of the same real system hang off different duplicates.
for row in raw:
    g = by_golden[row["_golden"]]
    if not g["parent_golden_id"]:
        continue
    parents = records_of[g["parent_golden_id"]]
    parent = rng.choice(parents)
    row["PARENT_ASSET_ID"] = parent["ASSET_ID"]
    if len(parents) > 1:
        log(row["ASSET_ID"], "PARENT_ASSET_ID", "parent_is_duplicate",
            f"parent {g['parent_golden_id']} has {len(parents)} records; linked to {parent['ASSET_ID']}")
    r = rng.random()
    if r < 0.03:
        row["PARENT_ASSET_ID"] = ""
        log(row["ASSET_ID"], "PARENT_ASSET_ID", "missing_parent", f"should be under {g['parent_golden_id']}")
    elif r < 0.06:
        row["PARENT_ASSET_ID"] = new_id(rng.choice(SOURCES))  # reserved, so no record ever gets this ID
        log(row["ASSET_ID"], "PARENT_ASSET_ID", "orphan_parent", f"{row['PARENT_ASSET_ID']} doesn't exist; should be {g['parent_golden_id']}")
    elif r < 0.10:
        row["PARENT_ASSET_ID"] = by_golden[g["parent_golden_id"]]["asset_tag"]
        log(row["ASSET_ID"], "PARENT_ASSET_ID", "parent_by_tag", "parent entered as its tag, not its ID")
    elif r < 0.13 and g["asset_level"] == 3:
        grand = by_golden[by_golden[g["parent_golden_id"]]["parent_golden_id"]]
        row["PARENT_ASSET_ID"] = rng.choice(records_of[grand["golden_id"]])["ASSET_ID"]
        log(row["ASSET_ID"], "PARENT_ASSET_ID", "level_skipped", f"equipment linked straight to facility {grand['golden_id']}")

# Two circular references: a system whose parent is one of its own equipment records.
cycles = 0
for s in rng.sample([g for g in golden if g["asset_level"] == 2], 20):
    srow = records_of[s["golden_id"]][0]
    kid = next((r for r in raw if r["PARENT_ASSET_ID"] == srow["ASSET_ID"]), None)
    if kid and srow["PARENT_ASSET_ID"]:
        srow["PARENT_ASSET_ID"] = kid["ASSET_ID"]
        log(srow["ASSET_ID"], "PARENT_ASSET_ID", "circular_parent", f"parent is its own child {kid['ASSET_ID']}")
        cycles += 1
    if cycles == 2:
        break

# A re-run load: some rows appear twice, identical.
rng.shuffle(raw)
for row in rng.sample(raw, 8):
    raw.append(dict(row))
    log(row["ASSET_ID"], "*", "exact_duplicate_row", "row loaded twice")
rng.shuffle(raw)

# --- write ------------------------------------------------------------------------

COLUMNS = ["ASSET_ID", "ASSET_TAG", "ASSET_DESC", "ASSET_LEVEL", "ASSET_CLASS", "PARENT_ASSET_ID", "SITE_CODE",
           "REGION", "STATUS", "MANUFACTURER", "MODEL", "SERIAL_NO", "INSTALL_DATE", "CRITICALITY", "RATING",
           "LATITUDE", "LONGITUDE", "SOURCE_SYSTEM", "CREATED_BY", "CREATED_DATE", "COMMENTS"]

with open(HERE / "ASSET_HIERARCHY.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, COLUMNS, extrasaction="ignore", lineterminator="\r\n")
    w.writeheader()
    w.writerows(raw)

GOLDEN_COLUMNS = ["golden_id", "asset_level", "asset_tag", "asset_name", "asset_class", "parent_golden_id",
                  "site_code", "region", "status", "manufacturer", "model", "serial_no", "install_date",
                  "criticality", "rating", "latitude", "longitude"]
with open(HERE / "ASSET_GOLDEN.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, GOLDEN_COLUMNS, extrasaction="ignore")
    w.writeheader()
    w.writerows(golden)

seen = set()
with open(HERE / "ASSET_MATCH.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["asset_id", "golden_id", "source_system"])
    for row in sorted(raw, key=lambda r: (r["_golden"], r["ASSET_ID"])):
        if row["ASSET_ID"] not in seen:
            seen.add(row["ASSET_ID"])
            w.writerow([row["ASSET_ID"], row["_golden"], row["SOURCE_SYSTEM"]])

with open(HERE / "DQ_ISSUES.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, ["asset_id", "column", "issue", "detail"])
    w.writeheader()
    w.writerows(issues)

levels = {lvl: sum(1 for g in golden if g["asset_level"] == lvl) for lvl in (1, 2, 3)}
print(f"golden assets: {len(golden)} {levels}")
print(f"raw records:   {len(raw)} (unique ids {len(seen)})")
print(f"issues:        {len(issues)}")
