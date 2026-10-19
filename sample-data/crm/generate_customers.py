"""Generates CUSTOMER.csv: fictional CRM customer records for a water utility.

Everything is synthetic. Contact details use ranges reserved for testing or
fiction so nothing points at a real person:
  - email      @example.com / .net / .org (RFC 2606)
  - phones     (08) 5550 xxxx and 0491 570 xxx (ACMA ranges for fictional use)
  - IPs        192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 (RFC 5737)
  - bank / concession numbers are random and not checksum-valid
Suburbs and postcodes are real Adelaide localities; street numbers are random.

Usage: python3 generate_customers.py [rows] > CUSTOMER.csv
"""
import csv
import random
import sys
from datetime import date, datetime, timedelta

ROWS = int(sys.argv[1]) if len(sys.argv) > 1 else 1000
rng = random.Random(20261020)

FIRST_F = ["Olivia", "Charlotte", "Amelia", "Isla", "Mia", "Grace", "Chloe", "Sophie", "Priya", "Ananya", "Mei",
           "Linh", "Fatima", "Aisha", "Zoe", "Hannah", "Ruby", "Lucy", "Maria", "Elena", "Sarah", "Emily", "Jessica",
           "Ngoc", "Yasmin", "Leila", "Siobhan", "Margaret", "Patricia", "Helen", "Kiri", "Tahlia"]
FIRST_M = ["Oliver", "Jack", "William", "Noah", "Thomas", "James", "Lucas", "Henry", "Arjun", "Rohan", "Wei", "Jun",
           "Minh", "Omar", "Ahmed", "Daniel", "Matthew", "Liam", "Ethan", "Samuel", "George", "Nikolaos", "Marco",
           "Giuseppe", "Hamid", "Kwame", "Peter", "Robert", "David", "Michael", "Tane", "Jarrah"]
LAST = ["Smith", "Jones", "Williams", "Brown", "Wilson", "Taylor", "Nguyen", "Tran", "Le", "Johnson", "White",
        "Martin", "Anderson", "Thompson", "Patel", "Singh", "Sharma", "Chen", "Wang", "Li", "Zhang", "Kelly",
        "Ryan", "O'Connor", "Murphy", "Papadopoulos", "Rossi", "Bianchi", "Haddad", "Khan", "Ali", "Walker",
        "Hall", "Young", "King", "Wright", "Scott", "Green", "Baker", "Mitchell", "Campbell", "Roberts"]
STREETS = ["Main North Rd", "Prospect Rd", "Grange Rd", "Henley Beach Rd", "Magill Rd", "Glen Osmond Rd",
           "Goodwood Rd", "Marion Rd", "Brighton Rd", "Diagonal Rd", "Unley Rd", "Portrush Rd", "Payneham Rd",
           "Fullarton Rd", "Esplanade", "Victoria St", "King William St", "George St", "Rundle St", "Wattle Ave",
           "Banksia Cres", "Gum Tree Dr", "Kurrajong Ct", "Acacia Way", "Jacaranda Pl", "Bottlebrush Ln"]
# (suburb, postcode, latitude, longitude) — approximate locality centres.
SUBURBS = [
    ("Adelaide", "5000", -34.9285, 138.6007), ("North Adelaide", "5006", -34.9065, 138.5930),
    ("Prospect", "5082", -34.8840, 138.5940), ("Norwood", "5067", -34.9210, 138.6300),
    ("Unley", "5061", -34.9500, 138.6070), ("Glenelg", "5045", -34.9800, 138.5150),
    ("Henley Beach", "5022", -34.9200, 138.4940), ("Marion", "5043", -35.0100, 138.5550),
    ("Salisbury", "5108", -34.7600, 138.6400), ("Elizabeth", "5112", -34.7200, 138.6700),
    ("Modbury", "5092", -34.8330, 138.6830), ("Port Adelaide", "5015", -34.8470, 138.5070),
    ("Mount Barker", "5251", -35.0670, 138.8580), ("Gawler", "5118", -34.6000, 138.7450),
    ("Noarlunga Centre", "5168", -35.1400, 138.4950), ("Burnside", "5066", -34.9400, 138.6450),
    ("Campbelltown", "5074", -34.8820, 138.6650), ("Mawson Lakes", "5095", -34.8150, 138.6100),
    ("Brighton", "5048", -35.0170, 138.5230), ("Murray Bridge", "5253", -35.1200, 139.2750),
]
BUSINESS = ["Coastal Laundromat", "Hills Organic Nursery", "Northside Car Wash", "Bayview Cafe", "Parkside Dental",
            "Metro Fitness Centre", "Riverbank Brewing Co", "Sunrise Childcare", "Greenway Bakery", "Harbour Seafoods",
            "Eastend Motors", "Westfield Florist", "Kooyonga Golf Club", "Torrens Hotel", "Plains Dairy Supplies"]
STAFF = ["jsmith", "akumar", "bo'connor", "tpapadop", "lnguyen", "mwhite", "crm_integration", "web_portal"]


def pick(weighted):
    items, weights = zip(*weighted)
    return rng.choices(items, weights)[0]


def rand_date(start, end):
    return start + timedelta(days=rng.randint(0, (end - start).days))


def mobile():
    return f"0491 570 {rng.randint(6, 159):03d}"


def landline():
    return f"(08) 5550 {rng.randint(0, 9999):04d}"


rows = []
used_emails = set()
for i in range(ROWS):
    business = rng.random() < 0.15
    gender = pick([("F", 48), ("M", 47), ("X", 2), ("U", 3)])
    first = rng.choice(FIRST_F if gender == "F" else FIRST_M if gender == "M" else FIRST_F + FIRST_M)
    last = rng.choice(LAST)
    suburb, postcode, lat, lon = rng.choice(SUBURBS)
    created = rand_date(date(2012, 1, 1), date(2026, 6, 30))
    modified = rand_date(created, date(2026, 10, 15))
    status = pick([("ACTIVE", 80), ("INACTIVE", 10), ("PROSPECT", 6), ("CLOSED", 4)])
    payment = pick([("DIRECT DEBIT", 45), ("BPAY", 30), ("CARD", 15), ("CENTREPAY", 5), ("CHEQUE", 5)])
    concession = "NONE" if business else pick([("NONE", 70), ("PENSIONER", 18), ("HEALTH CARE CARD", 8), ("DVA", 4)])

    local = f"{first}.{last}".lower().replace("'", "")
    email = f"{local}@{rng.choice(['example.com', 'example.net', 'example.org'])}"
    while email in used_emails:
        email = f"{local}{rng.randint(1, 999)}@{email.split('@')[1]}"
    used_emails.add(email)

    notes = rng.choice([
        "", "", "", "Prefers contact after 5pm.", "Requested paper bills.", "Hardship plan discussed.",
        "Reported low water pressure.", "Leak allowance applied.", "Meter access via side gate - dog on property.",
        f"Call back on {mobile()} re payment plan.", "Moved in, property transfer from previous owner.",
        "Complaint about bill estimate - resolved.", "Interested in rainwater tank rebate.",
    ])

    rows.append({
        "customer_id": 200001 + i,
        "customer_account_no": f"WC-{rng.randint(1000000, 9999999)}",
        "customer_type": "BUSINESS" if business else "RESIDENTIAL",
        "company_name": rng.choice(BUSINESS) if business else "",
        "title": "" if business else rng.choice({"F": ["Ms", "Mrs", "Miss", "Dr"], "M": ["Mr", "Dr"]}.get(gender, ["Mx", ""])),
        "first_name": first,
        "last_name": last,
        "preferred_name": first[:3] if rng.random() < 0.08 else "",
        "date_of_birth": "" if business else rand_date(date(1940, 1, 1), date(2004, 12, 31)).isoformat(),
        "gender": "" if business else gender,
        "email": email,
        "mobile_phone": mobile() if rng.random() < 0.9 else "",
        "home_phone": landline() if rng.random() < 0.4 else "",
        "street_address": f"{rng.randint(1, 250)} {rng.choice(STREETS)}",
        "suburb": suburb,
        "state": "SA",
        "postcode": postcode,
        "latitude": round(lat + rng.uniform(-0.01, 0.01), 6),
        "longitude": round(lon + rng.uniform(-0.01, 0.01), 6),
        "customer_status": status,
        "segment": pick([("STANDARD", 75), ("HARDSHIP", 7), ("LIFE SUPPORT", 2), ("KEY ACCOUNT", 6), ("NEW CONNECTION", 10)]),
        "lead_source": pick([("PROPERTY TRANSFER", 55), ("WEBSITE", 20), ("CALL CENTRE", 15), ("REFERRAL", 6), ("EVENT", 4)]),
        "preferred_contact_method": pick([("EMAIL", 50), ("SMS", 25), ("PHONE", 15), ("POST", 10)]),
        "marketing_opt_in": "Y" if rng.random() < 0.35 else "N",
        "concession_type": concession,
        "concession_card_number": "" if concession == "NONE" else f"{rng.randint(100, 999)}-{rng.randint(100, 999)}-{rng.randint(100, 999)}{rng.choice('ABCDEFGHJK')}",
        "payment_method": payment,
        "bsb": f"{rng.randint(10, 99)}{rng.randint(0, 9)}-{rng.randint(0, 999):03d}" if payment == "DIRECT DEBIT" else "",
        "bank_account_number": f"{rng.randint(10000000, 99999999)}" if payment == "DIRECT DEBIT" else "",
        "portal_username": f"{local}{rng.randint(1, 99)}" if rng.random() < 0.6 else "",
        "last_login_ip": f"{rng.choice(['192.0.2', '198.51.100', '203.0.113'])}.{rng.randint(1, 254)}" if rng.random() < 0.6 else "",
        "account_manager": rng.choice(STAFF[:6]) if business else "",
        "lifetime_value": round(rng.uniform(300, 4000) * (6 if business else 1), 2),
        "last_contact_date": rand_date(created, date(2026, 10, 15)).isoformat(),
        "created_date": datetime.combine(created, datetime.min.time()).isoformat(sep=" "),
        "created_by": rng.choice(STAFF),
        "last_modified_date": datetime.combine(modified, datetime.min.time()).isoformat(sep=" "),
        "last_modified_by": rng.choice(STAFF),
        "notes": notes,
    })

writer = csv.DictWriter(sys.stdout, fieldnames=list(rows[0].keys()), lineterminator="\n")
writer.writeheader()
writer.writerows(rows)
