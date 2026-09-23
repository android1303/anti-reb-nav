#!/usr/bin/env python3
"""
Порівняння траєкторії Dead Reckoning з еталонним GPS.

  python3 tools/replay/compare.py <файл.csv> [--align-m 280] [--plot out.png]

Працює і з логом з телефону, і з виходом replay.mjs (потрібні posX, posY, lat, lon, timestamp).
Методика (Master Plan, розд. 5): траєкторія DR вирівнюється з GPS жорстким поворотом+зсувом
лише за першими --align-m метрами GPS-шляху (відомі старт і напрямок), далі — тільки датчики.
Точки GPS беруться лише в моменти оновлення координат.
"""
import argparse, sys
import numpy as np
import pandas as pd

ap = argparse.ArgumentParser()
ap.add_argument('csv')
ap.add_argument('--align-m', type=float, default=280.0)
ap.add_argument('--plot', default=None)
a = ap.parse_args()

df = pd.read_csv(a.csv)
df = df.dropna(subset=['lat', 'lon']).reset_index(drop=True)
if df.empty:
    sys.exit('Немає GPS-даних (lat/lon) — порівняння неможливе.')
t = (df.timestamp - df.timestamp.iloc[0]) / 1000.0
lat0, lon0, R = df.lat.iloc[0], df.lon.iloc[0], 6371000.0
gE = np.radians(df.lon - lon0) * R * np.cos(np.radians(lat0))
gN = np.radians(df.lat - lat0) * R

chg = df[['lat', 'lon']].ne(df[['lat', 'lon']].shift()).any(axis=1).to_numpy().copy()
chg[0] = False  # перша точка часто застаріла
A = df[['posX', 'posY']].values[chg]
B = np.c_[gE[chg], gN[chg]]
tt = t.values[chg]
if len(B) < 4:
    sys.exit('Замало оновлень GPS для порівняння.')
path = np.r_[0, np.cumsum(np.hypot(*np.diff(B, axis=0).T))]
m = path <= a.align_m
if m.sum() < 3:
    m[:3] = True

ca, cb = A[m].mean(0), B[m].mean(0)
U, S, Vt = np.linalg.svd((A[m] - ca).T @ (B[m] - cb))
d = np.sign(np.linalg.det(U @ Vt))
Rm = (U @ np.diag([1, d]) @ Vt).T
P = (Rm @ (A - ca).T).T + cb
err = np.hypot(*(P - B).T)

dr_dist = np.hypot(*np.diff(df[['posX', 'posY']].values, axis=0).T).sum()
print(f'Файл: {a.csv}')
print(f'Тривалість {t.iloc[-1]:.0f} с | GPS-шлях {path[-1]:.0f} м | DR-шлях {dr_dist:.0f} м | вирівнювання за {path[m][-1]:.0f} м')
if d < 0:
    print('УВАГА: найкраще вирівнювання — дзеркальне. Перевір YAW_SIGN або ділянка вирівнювання занадто пряма.')
print(f'Кінцева похибка {err[-1]:.1f} м | макс {err.max():.1f} м | RMS {np.sqrt((err**2).mean()):.1f} м | '
      f'{100*err[-1]/max(path[-1],1):.1f}% шляху | {1000*err[-1]/max(path[-1],1):.0f} м/км')
print('\n   t, с   GPS-шлях, м   похибка, м')
for ti, pi, ei in zip(tt, path, err):
    print(f'{ti:7.1f} {pi:12.0f} {ei:12.1f}')

if a.plot:
    try:
        import matplotlib; matplotlib.use('Agg')
        import matplotlib.pyplot as plt
    except ImportError:
        sys.exit('matplotlib не встановлено — графік пропущено.')
    allP = (Rm @ (df[['posX', 'posY']].values - ca).T).T + cb
    plt.figure(figsize=(6, 8))
    plt.plot(allP[:, 0], allP[:, 1], label='Dead Reckoning')
    plt.plot(B[:, 0], B[:, 1], 'o-', ms=3, label='GPS')
    plt.axis('equal'); plt.grid(alpha=.3); plt.legend(); plt.xlabel('Схід, м'); plt.ylabel('Північ, м')
    plt.title(f'Похибка {err[-1]:.0f} м на {path[-1]:.0f} м')
    plt.savefig(a.plot, dpi=120, bbox_inches='tight')
    print(f'\nГрафік: {a.plot}')
