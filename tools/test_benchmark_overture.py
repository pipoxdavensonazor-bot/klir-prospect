import unittest
import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location('benchmark_overture', Path(__file__).with_name('benchmark-overture.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
select = module.select

def feature(id, lon=-73.5673, lat=45.5017, name='Atelier', street='1 Rue Exemple', category='contractor', status=None):
    return {'id':id,'geometry':{'type':'Point','coordinates':[lon,lat]},'properties':{'names':{'primary':name},'addresses':[{'freeform':street,'postcode':'H0H0H0'}],'taxonomy':{'primary':category,'hierarchy':[category]},'operating_status':status}}

class Boundaries(unittest.TestCase):
    def test_same_brand_different_establishment_remains_distinct(self):
        a,b,c=feature('a'),feature('b',street='2 Rue Exemple'),feature('c')
        rows,count,duplicates=select([a,b,c],'montreal','construction')
        self.assertEqual(count,3)
        self.assertEqual([f['id'] for f in rows],['a','b'])
        self.assertEqual(duplicates,['c'])

    def test_radius_sector_closed_and_limit(self):
        rows,count,_=select([feature('outside',lat=46),feature('wrong',category='pharmacy'),feature('closed',status='permanently_closed')],'montreal','construction')
        self.assertEqual((rows,count),([],0))
        rows,_,_=select([feature(str(n).zfill(2),street=f'{n} Rue Exemple') for n in range(50)],'montreal','construction')
        self.assertEqual(len(rows),40)

if __name__=='__main__': unittest.main()
