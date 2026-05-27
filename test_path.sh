#!/bin/bash
cd /mnt/s/Photogram/backend
python3 -c "
import sys
sys.path.insert(0, '/mnt/s/Photogram/backend')
from tasks.pipeline import _normalize_path
p = _normalize_path('S:\\\\Photogram\\\\outputs\\\\staging\\\\c45a954a-cd02-4c1d-b052-1988e96a8d2e')
print('Normalized:', p)
print('Exists:', p.exists())
if p.exists():
    import os; files = os.listdir(str(p)); print('Files:', files[:3])
else:
    print('Trying alt path:')
    from pathlib import Path
    alt = Path('/mnt/s/Photogram/outputs/staging/c45a954a-cd02-4c1d-b052-1988e96a8d2e')
    print('Alt exists:', alt.exists())
    if alt.exists():
        print('Alt files:', list(alt.iterdir())[:2])
"
