"""Offline tests; no Docker invocation, account change or database connection."""
import unittest
from managed_loopback import container_ports, check_listeners, endpoint_ports, find_report


def container(requested='127.0.0.1', effective='127.0.0.1', port='55432'):
    return {'HostConfig': {'PortBindings': {'5432/tcp': [{'HostIp': requested, 'HostPort': port}]}},
            'NetworkSettings': {'Ports': {'5432/tcp': [{'HostIp': effective, 'HostPort': port}]}}}


class LoopbackSafety(unittest.TestCase):
    def test_explicit_and_effective_bindings(self):
        self.assertEqual(container_ports([container()]), {55432})
        for ip in ['', '0.0.0.0', '::', '::1', '192.168.1.10']:
            for requested, effective in [(ip, '127.0.0.1'), ('127.0.0.1', ip)]:
                with self.subTest(requested=requested, effective=effective), self.assertRaises(RuntimeError):
                    container_ports([container(requested, effective)])

    def test_no_publications_and_invalid_port(self):
        with self.assertRaises(RuntimeError):
            container_ports([])
        with self.assertRaises(RuntimeError):
            container_ports([container(port='0')])
        stopped = container()
        stopped['NetworkSettings']['Ports']['5432/tcp'] = None
        with self.assertRaises(RuntimeError):
            container_ports([stopped, container()])

    def test_real_listeners_required_and_all_checked(self):
        check_listeners({55432}, [{'LocalPort': 55432, 'LocalAddress': '127.0.0.1'}])
        for ip in ['0.0.0.0', '::', '::1']:
            with self.subTest(ip=ip), self.assertRaises(RuntimeError):
                check_listeners({55432}, [{'LocalPort': 55432, 'LocalAddress': '127.0.0.1'},
                                         {'LocalPort': 55432, 'LocalAddress': ip}])
        with self.assertRaises(RuntimeError):
            check_listeners({55432}, [])

    def test_stack_endpoints_cannot_select_remote_database(self):
        report = {'endpoints': {'api': {'address': '127.0.0.1', 'port': 55421}},
                  'env': {'DB_URL': 'postgresql://postgres@127.0.0.1:55432/postgres'}}
        self.assertEqual(endpoint_ports(report), {55421, 55432})
        for host in ['db.pwakjxjjxswdjsapsbxn.supabase.co', 'db.cbklwmjudobqwbkbxqgy.supabase.co', 'localhost', '::1']:
            bad = {**report, 'env': {'DB_URL': f'postgresql://postgres@{host}:55432/postgres'}}
            with self.subTest(host=host), self.assertRaises((RuntimeError, ValueError)):
                endpoint_ports(bad)

    def test_metadata_wrapper_and_missing_metadata(self):
        report = {'identity': {'id': 'synthetic'}, 'services': [], 'env': {}}
        self.assertIs(find_report({'result': report}), report)
        self.assertIsNone(find_report({'message': 'not a stack report'}))


if __name__ == '__main__':
    unittest.main()
