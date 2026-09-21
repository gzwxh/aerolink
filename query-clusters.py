import sqlite3
con = sqlite3.connect('/mnt/g/gocodework/kite/dev.db')
cur = con.cursor()
for row in cur.execute('SELECT id,name,config,updated_at FROM clusters').fetchall():
    cfg = str(row[2])
    import re
    m = re.findall(r'https?://[^"\']+', cfg)
    print(row[0], '|', row[1], '|', row[3])
    print('   地址:', m if m else str(cfg)[:100])
