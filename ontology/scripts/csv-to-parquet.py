#!/usr/bin/env python3
"""Convert the seed CSVs into typed Parquet files for the clean backing datasets.

Foundry's object index reads tabular (Parquet) datasets; a CSV uploaded as a
raw file with a schema stamped on it is not readable by object types (found at
U3, 2026-09-10). Raw CSV uploads live under data/raw; the Parquet output of this
script is uploaded to the clean datasets under data/clean, which the object
types point at. Run with the foundry-cli tool's interpreter, which has pyarrow:
  ~/.local/share/uv/tools/foundry-cli/bin/python ontology/scripts/csv-to-parquet.py <seed-dir> <out-dir>
"""
import csv, sys, datetime as dt, os
import pyarrow as pa, pyarrow.parquet as pq

def ts(v): return dt.datetime.fromisoformat(v.replace("Z", "+00:00")) if v else None

SPECS = {
    "sites":  [("siteId", pa.string(), False), ("name", pa.string(), False)],
    "teams":  [("teamId", pa.string(), False), ("name", pa.string(), False)],
    "users":  [("userId", pa.string(), False), ("fullName", pa.string(), False), ("phoneE164", pa.string(), False),
               ("pinHash", pa.string(), False), ("siteId", pa.string(), False)],
    "issues": [("issueId", pa.string(), False), ("title", pa.string(), False), ("description", pa.string(), False),
               ("status", pa.string(), False), ("priority", pa.string(), False), ("resolution", pa.string(), True),
               ("reportedByUserId", pa.string(), False), ("assignedTeamId", pa.string(), False),
               ("sourceConversationId", pa.string(), True),
               ("createdAt", pa.timestamp("ms", tz="UTC"), False), ("updatedAt", pa.timestamp("ms", tz="UTC"), False)],
}
CONVERTERS = {"createdAt": ts, "updatedAt": ts}

def main(seed_dir: str, out_dir: str) -> None:
    os.makedirs(out_dir, exist_ok=True)
    for name, fields in SPECS.items():
        with open(os.path.join(seed_dir, f"{name}.csv"), newline="") as f:
            rows = list(csv.DictReader(f))
        cols = {}
        for fname, ftype, nullable in fields:
            vals = []
            for r in rows:
                v = r.get(fname, "")
                if fname in CONVERTERS: v = CONVERTERS[fname](v)
                elif nullable and v == "": v = None
                vals.append(v)
            cols[fname] = pa.array(vals, type=ftype)
        schema = pa.schema([pa.field(f, t, nullable=n) for f, t, n in fields])
        table = pa.table(cols, schema=schema)
        pq.write_table(table, os.path.join(out_dir, f"{name}.parquet"))
        print(f"{name}: {table.num_rows} rows -> {out_dir}/{name}.parquet")

if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: csv-to-parquet.py <seed-dir> <out-dir>")
    main(sys.argv[1], sys.argv[2])
