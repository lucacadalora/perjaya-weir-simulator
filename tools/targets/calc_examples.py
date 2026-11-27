"""Worked examples (lane r13): recompute every test target by code. Writes calc_out.json next to this file."""
import json, math, os, sys
import numpy as np
from statistics import NormalDist
Z=NormalDist().inv_cdf
def kt(p,g):
    z=Z(p)
    if abs(g)<1e-9: return z
    return (2/g)*((1+g*z/6-g*g/36)**3-1)  # Wilson-Hilferty

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "calc_out.json")
G = 9.81
R = {}

# ---------- E1 rain to flow ----------
# runoff coefficient, monthly
A_km2, P_mm, C, days = 4320.0, 300.0, 0.5, 30
R["e1_coef_month_Q"] = C * P_mm / 1000 * A_km2 * 1e6 / (days * 86400)
# rational method, peak
R["e1_rational_Q"] = 0.278 * 0.6 * 20.0 * 100.0

# F.J. Mock one month
def mock_month(P, n_rain, Ep, m, SMC, SM0, i, k, V0, PF=0.0):
    dE = Ep * (m / 20.0) * (18 - n_rain)
    Et = Ep - dE
    ds = P - Et
    sm = min(SMC, SM0 + ds) if ds < 0 or SM0 < SMC else SMC
    soil_change = sm - SM0
    WS = max(0.0, ds - soil_change)
    I = i * WS
    V = k * V0 + 0.5 * (1 + k) * I
    dV = V - V0
    BF = I - dV
    DRO = WS - I
    SRO = PF * P if ds < 0 else 0.0
    return dict(dE=dE, Et=Et, WS=WS, I=I, V=V, BF=BF, DRO=DRO, RO=BF + DRO + SRO, SM=sm)
mk = mock_month(P=300, n_rain=15, Ep=120, m=0.30, SMC=200, SM0=200, i=0.4, k=0.6, V0=100)
R["e1_mock"] = mk
R["e1_mock_Q"] = mk["RO"] / 1000 * A_km2 * 1e6 / (30 * 86400)
# dry month: P below Et, soil drawn down
mk2 = mock_month(P=60, n_rain=5, Ep=135, m=0.30, SMC=200, SM0=200, i=0.4, k=0.6, V0=119.33)
R["e1_mock_dry"] = mk2

# NRECA one month (Crawford & Thurin 1981 structure)
def nreca_month(P, PET, Ra, W0, PSUB, GWF, GW0, C_aet=1.0):
    nominal = 100 + 0.2 * Ra
    Wi = W0 / nominal
    r = P / PET
    if r < 1 and Wi < 2:
        aet_ratio = r * (1 - 0.5 * Wi) + 0.5 * Wi
    else:
        aet_ratio = 1.0
    AET = aet_ratio * PET * C_aet
    WB = P - AET
    EXMR = 0.5 * (1 + math.tanh((Wi - 1) / 0.52)) if WB > 0 else 0.0
    EM = EXMR * WB
    dS = WB - EM
    rech = PSUB * EM
    gwflow = GWF * (GW0 + rech)
    direct = EM - rech
    return dict(nominal=nominal, Wi=Wi, AET=AET, WB=WB, EXMR=EXMR, EM=EM, dS=dS, rech=rech,
                gwflow=gwflow, direct=direct, total=gwflow + direct, W1=W0 + dS, GW1=GW0 + rech - gwflow)
R["e1_nreca"] = nreca_month(P=300, PET=120, Ra=2800, W0=600, PSUB=0.5, GWF=0.5, GW0=100)

# daily bucket: soil store overflows into a linear fast reservoir
Smax, S0, Pday, K = 150.0, 120.0, 100.0, 2.0
over = max(0.0, S0 + Pday - Smax)
q1_mm = over * (1 - math.exp(-1 / K))
R["e1_bucket_q1_mm"] = q1_mm
R["e1_bucket_Q1"] = q1_mm / 1000 * A_km2 * 1e6 / 86400

# ---------- dependable flow ----------
flows = [420, 380, 350, 300, 280, 260, 240, 210, 190, 150]  # synthetic, one half-month over 10 years
s = sorted(flows, reverse=True)
n = len(s)
m = 0.8 * (n + 1)  # Weibull P = m/(n+1) exceedance
lo = int(math.floor(m))
R["q80_weibull"] = s[lo - 1] + (m - lo) * (s[lo] - s[lo - 1])
mu, sd = np.mean(flows), np.std(flows, ddof=1)
R["q80_normal"] = mu + Z(0.2) * sd
R["q80_basic_year_rank"] = n / 5 + 1

# ---------- E6 irrigation ----------
def lp(M, T, S):
    k = M * T / S
    return M * math.exp(k) / (math.exp(k) - 1)
R["lp_M5_T30_S250"] = lp(5.0, 30, 250)
R["lp_M11_T45_S300"] = lp(11.0, 45, 300)
ETo, P = 4.0, 2.0
R["lp_case"] = lp(1.1 * ETo + P, 30, 250)
Re = 0.7 * 90 / 15
NFR = 1.10 * ETo + P + 3.3 - Re
R["re"] = Re
R["nfr"] = NFR
R["dr_lpsha"] = NFR / (8.64 * 0.65)
R["dr_kp01_example_5p5"] = 5.5 / (8.64 * 0.65)
R["lp_dr_lpsha"] = (R["lp_case"] - Re) / (8.64 * 0.65)
# three groups staggered 15 days: one in LP, two growing
R["golongan_avg_nfr"] = ((R["lp_case"] - Re) + NFR + (1.05 * ETo + P + 3.3 - Re)) / 3

# ---------- E3 gates ----------
def gate_kp02(mu, a, b, h1, K=1.0):
    return K * mu * a * b * math.sqrt(2 * G * h1)
R["gate_free"] = gate_kp02(0.60, 1.0, 10.0, 5.0)
R["intake_submerged"] = 0.80 * 3.0 * 1.5 * math.sqrt(2 * G * 0.20)
def crest(Cd, b, H1):
    return Cd * (2 / 3) * math.sqrt(2 / 3 * G) * b * H1 ** 1.5
R["crest_Q"] = crest(1.30, 100.0, 3.0)
R["be"] = 100 - 2 * (4 * 0.01 + 0.10) * 3.0
R["crest_Q_be"] = crest(1.30, R["be"], 3.0)
# energy form sluice (Henderson): Q = Cc a b sqrt(2 g (h1 - Cc a)) / sqrt(1 - (Cc a / h1)^2) ... use Cd form
Cc = 0.61
y2 = Cc * 1.0
R["gate_energy"] = 10.0 * y2 * math.sqrt(2 * G * (5.0 - y2) / (1 - (y2 / 5.0) ** 2))

# ---------- E2 storage / routing ----------
z = np.array([[10, 11, 12], [9, 10, 11], [8, 9, 13]], float)
cell = 30.0 * 30.0
h = 10.5
R["grid_vol"] = float(np.sum(np.clip(h - z, 0, None)) * cell)
R["grid_area"] = float(np.sum(z < h) * cell)
Csp, bsp = 2.2, 100.0
R["pool_equilibrium_H"] = (500 / (Csp * bsp)) ** (2 / 3)
# one explicit step
Apond, H0, I, dt = 2e6, 1.0, 500.0, 3600.0
O0 = Csp * bsp * H0 ** 1.5
R["pool_step_H1"] = H0 + (I - O0) * dt / Apond
# Puls trapezoid step with linear storage and linear outflow O = c*H for closed form check
# S = Apond*H, O = 100*H ; (I1+I2)/2 - (O1+O2)/2 = (S2-S1)/dt
c = 100.0
I1 = I2 = 500.0
H1 = 1.0
H2 = ((I1 + I2) / 2 - c * H1 / 2 + Apond * H1 / dt) / (Apond / dt + c / 2)
R["puls_linear_H2"] = H2

# ---------- E4 D8 / fill / HAND on toy grid ----------
dem = np.array([
    [9, 8, 7, 8, 9],
    [8, 6, 5, 6, 8],
    [7, 5, 3, 5, 7],
    [8, 6, 2, 6, 8],
    [9, 7, 1, 7, 9]], float)
rows, cols = dem.shape
nbr = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
def d8(dem):
    fd = {}
    for r in range(rows):
        for c_ in range(cols):
            best, tgt = 0.0, None
            for dr, dc in nbr:
                rr, cc = r + dr, c_ + dc
                if 0 <= rr < rows and 0 <= cc < cols:
                    dist = math.sqrt(2) if dr and dc else 1.0
                    slope = (dem[r, c_] - dem[rr, cc]) / dist
                    if slope > best:
                        best, tgt = slope, (rr, cc)
            fd[(r, c_)] = tgt
    return fd
fd = d8(dem)
acc = np.ones_like(dem)
order = sorted(((dem[r, c_], r, c_) for r in range(rows) for c_ in range(cols)), reverse=True)
for _, r, c_ in order:
    t = fd[(r, c_)]
    if t:
        acc[t] += acc[r, c_]
R["d8_acc_outlet"] = float(acc[4, 2])
R["d8_area_outlet_m2"] = float(acc[4, 2] * cell)
# flood fill behind a dam line across row 3 at crest 6: cells connected to (2,2) with z < 6 and above row 3 dam line
from collections import deque
crest_el = 6.0
seen, q = set([(2, 2)]), deque([(2, 2)])
while q:
    r, c_ = q.popleft()
    for dr, dc in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
        rr, cc = r + dr, c_ + dc
        if 0 <= rr < 3 and 0 <= cc < cols and (rr, cc) not in seen and dem[rr, cc] < crest_el:
            seen.add((rr, cc)); q.append((rr, cc))
R["fill_cells"] = len(seen)
R["fill_vol_m3"] = float(sum((crest_el - dem[p]) for p in seen) * cell)
# HAND: drainage = cells with acc >= 3 ; hand = z - z(drain cell reached along D8)
drain = acc >= 3
hand = np.zeros_like(dem)
for r in range(rows):
    for c_ in range(cols):
        p = (r, c_)
        while not drain[p] and fd[p] is not None:
            p = fd[p]
        hand[r, c_] = dem[r, c_] - dem[p]
R["hand_cell_0_0"] = float(hand[0, 0])
R["hand_flooded_at_stage2"] = int(np.sum(hand <= 2.0))

# ---------- Manning ----------
b, zs, y, nM, S = 80.0, 2.0, 4.0, 0.035, 0.0003
Aq = (b + zs * y) * y
Pw = b + 2 * y * math.sqrt(1 + zs ** 2)
Rh = Aq / Pw
R["manning_Q"] = (1 / nM) * Aq * Rh ** (2 / 3) * math.sqrt(S)
R["manning_A"], R["manning_R"] = Aq, Rh

# ---------- evaporation ----------
R["eo_open_water"] = 0.7 * 4.6
R["evap_loss_m3d_1km2"] = R["eo_open_water"] / 1000 * 1e6

# ---------- flood frequency ----------
x = np.array([820, 950, 1100, 760, 1300, 1020, 880, 1450, 990, 1180], float)  # synthetic annual maxima
xm, xs = x.mean(), x.std(ddof=1)
Yn, Sn = 0.4952, 0.9496  # n = 10 (Gumbel reduced mean/sd table)
def gumbel(T):
    YT = -math.log(-math.log(1 - 1 / T))
    return xm + (YT - Yn) / Sn * xs
def gumbel_chow(T):
    K = -(math.sqrt(6) / math.pi) * (0.5772 + math.log(math.log(T / (T - 1))))
    return xm + K * xs
lx = np.log10(x)
lm, ls = lx.mean(), lx.std(ddof=1)
nn = len(lx)
g = nn * np.sum((lx - lm) ** 3) / ((nn - 1) * (nn - 2) * ls ** 3)
def lp3(T):
    K = kt(1 - 1 / T, g)
    return 10 ** (lm + K * ls), K
R["ff_mean"], R["ff_sd"] = xm, xs
R["gumbel_Q100"] = gumbel(100)
R["gumbel_chow_Q100"] = gumbel_chow(100)
R["gumbel_Q25"] = gumbel(25)
R["lp3_Cs"] = float(g)
R["lp3_Q100"], R["lp3_K100"] = lp3(100)
R["lp3_Q25"], R["lp3_K25"] = lp3(25)
R["KT_cs0_T100"] = float(kt(0.99, 0.0))
R["KT_cs05_T100"] = float(kt(0.99, 0.5))
R["KT_csm05_T100"] = float(kt(0.99, -0.5))

def conv(o):
    if isinstance(o, dict):
        return {k: conv(v) for k, v in o.items()}
    return round(float(o), 4)
R = conv(R)
if not OUT.startswith(os.path.dirname(os.path.abspath(__file__))):
    sys.exit("refuse")
json.dump(R, open(OUT, "w"), indent=1)
for k, v in R.items():
    print(k, v)
