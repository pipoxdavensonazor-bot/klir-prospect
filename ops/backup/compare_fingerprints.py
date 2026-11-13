#!/usr/bin/env python3
"""Compare deux empreintes produites par fingerprint.sql. Code 1 si différence.
N'affiche que les noms de clés différentes (aucune valeur)."""
import json, sys
a, b = (json.loads(open(p).read()) for p in sys.argv[1:3])
diff = sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))
if diff:
    print("empreintes DIFFÉRENTES :", ", ".join(diff)); sys.exit(1)
print(f"empreintes identiques ({len(a)} clés, {len(a.get('tables', {}))} tables)")
