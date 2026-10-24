"""Offline safety checks; no database connection, dump or restore."""
import ast
import io
from pathlib import Path
import tarfile
import unittest

source = Path(__file__).with_name('backup_restore.py')
tree = ast.parse(source.read_text(encoding='utf8'))
# Load definitions only: never execute the command-line workflow in these checks.
definitions = [n for n in tree.body if isinstance(n, (ast.Import, ast.ImportFrom, ast.FunctionDef))]
scope = {'__file__': str(source), 'TEST': 'pwakjxjjxswdjsapsbxn'}
exec(compile(ast.Module(body=definitions, type_ignores=[]), str(source), 'exec'), scope)


class RecoverySafety(unittest.TestCase):
    def test_source_identity_tls_and_session_pool(self):
        guard = scope['source_guard']
        guard('postgresql://postgres@db.pwakjxjjxswdjsapsbxn.supabase.co:5432/postgres?sslmode=require')
        guard('postgresql://postgres.pwakjxjjxswdjsapsbxn@aws-0-ca-central-1.pooler.supabase.com:5432/postgres?sslmode=require')
        for url in [
            'postgresql://postgres@db.cbklwmjudobqwbkbxqgy.supabase.co/postgres?sslmode=require',
            'postgresql://postgres.other@aws-0-ca-central-1.pooler.supabase.com/postgres?sslmode=require',
            'postgresql://postgres@db.pwakjxjjxswdjsapsbxn.supabase.co.evil.invalid/postgres?sslmode=require',
            'postgresql://postgres@db.pwakjxjjxswdjsapsbxn.supabase.co/postgres',
            'postgresql://postgres.pwakjxjjxswdjsapsbxn@aws-0-ca-central-1.pooler.supabase.com:6543/postgres?sslmode=require',
        ]:
            with self.subTest(url=url), self.assertRaises(RuntimeError):
                guard(url)

    def test_restore_local_only(self):
        guard = scope['target_guard']
        for host in ['localhost', '127.0.0.1', '[::1]']:
            guard(f'postgresql://postgres@{host}:55432/postgres')
        for host in ['db.pwakjxjjxswdjsapsbxn.supabase.co', 'db.cbklwmjudobqwbkbxqgy.supabase.co', 'localhost.evil.invalid', '192.168.1.2']:
            with self.subTest(host=host), self.assertRaises(RuntimeError):
                guard(f'postgresql://postgres@{host}/postgres')

    def test_archive_rejects_missing_duplicate_traversal_and_symlink(self):
        required = ['roles.sql', 'schema.sql', 'data.sql', 'auth-hooks.sql', 'manifest.json']
        def validate(names, symlink=False):
            data = io.BytesIO()
            with tarfile.open(fileobj=data, mode='w') as archive:
                for name in names:
                    member = tarfile.TarInfo(name)
                    if symlink and name == 'data.sql':
                        member.type = tarfile.SYMTYPE
                        member.linkname = '/private'
                    archive.addfile(member)
            data.seek(0)
            with tarfile.open(fileobj=data) as archive:
                return scope['archive_members'](archive)
        self.assertEqual(len(validate(required)), 5)
        for names, link in [(required[:-1], False), (required + ['data.sql'], False), (required + ['../outside.sql'], False), (required, True)]:
            with self.subTest(names=names, link=link), self.assertRaises(RuntimeError):
                validate(names, link)


if __name__ == '__main__':
    unittest.main()
