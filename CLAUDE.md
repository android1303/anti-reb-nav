# Anti-Reb Nav

@docs/MASTER_PLAN.md

## Правила роботи з кодом

- Гіроскоп expo-sensors віддає рад/с; ядро працює в град/с.
- Константи калібрування (YAW_SIGN, ZUPT_*, *_SCALE_FACTOR) змінювати
  лише за результатами аналізу CSV з полігону.
- Логіку ядра в telemetry.js (машина станів, ZUPT, DR) не змінювати без
  підтвердження відтворенням реального заїзду (див. розділ 4 плану).
- Збірка APK: GitHub Actions (assembleRelease), не EAS.
- Після змін в ядрі оновлювати розділи 3 і 10 у docs/MASTER_PLAN.md
  в тому ж коміті.

@AGENTS.md
