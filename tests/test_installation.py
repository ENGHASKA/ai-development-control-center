"""Portable lifecycle tests: no provider requests and no modifications to the host services."""
import importlib.util,io,json,os,pathlib,sqlite3,tarfile,tempfile,unittest
from types import SimpleNamespace
from unittest.mock import patch
SOURCE=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('manage',SOURCE/'libexec/manage.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class LifecycleTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.home=pathlib.Path(self.tmp.name);self.config=self.home/'config';self.config.mkdir(mode=0o700);self.previous=m.CONFIG;m.CONFIG=self.config
  self.c={'prefix':str(self.home/'app'),'workspace':str(self.home/'state'),'port':4430,'node':'/usr/bin/node','path':'/usr/bin:/bin','version':m.VERSION,'claude':'','codex':''}
  w=pathlib.Path(self.c['workspace']);(w/'tasks').mkdir(parents=True);(w/'projects').mkdir();(w/'worktrees').mkdir();(w/'logs').mkdir();(w/'reports').mkdir()
 def tearDown(self):m.CONFIG=self.previous;self.tmp.cleanup()
 def test_generated_units_are_portable_and_private(self):
  with patch.object(pathlib.Path,'home',return_value=self.home):units=m.services(self.c)
  task=(units/'adcc-task@.service').read_text();self.assertIn('NoNewPrivileges=yes',task);self.assertIn('MemoryMax=2500M',task);self.assertIn('Restart=no',task);self.assertIn(str(self.home/'app/current'),task)
 def test_unrelated_units_are_not_overwritten(self):
  with patch.object(pathlib.Path,'home',return_value=self.home):
   units=self.home/'.config/systemd/user';units.mkdir(parents=True);(units/'adcc-worker.service').write_text('unrelated')
   with self.assertRaises(ValueError):m.services(self.c)
 def test_unique_private_credentials(self):
  m.private(self.config/'test','sensitive');self.assertEqual((self.config/'test').stat().st_mode&0o777,0o600)
  import secrets
  self.assertNotEqual(secrets.token_urlsafe(32),secrets.token_urlsafe(32))
 def test_backup_restore_actual_database_and_relative_log_link(self):
  w=pathlib.Path(self.c['workspace']);db=w/'tasks/state.sqlite3'
  with sqlite3.connect(db) as c:c.execute('create table tasks(id text)');c.execute("insert into tasks values('test')")
  (w/'logs/attempt.log').write_text('retained');(w/'logs/latest.log').symlink_to('attempt.log');archive=self.home/'backup.tar.gz';m.backup(self.c,archive);dest=self.home/'restore';m.restore(self.c,archive,dest)
  self.assertEqual((dest/'logs/latest.log').read_text(),'retained')
  with sqlite3.connect(dest/'tasks/state.sqlite3') as c:self.assertEqual(c.execute('select id from tasks').fetchone()[0],'test')
 def test_restore_rejects_archive_escape(self):
  archive=self.home/'bad.tar.gz'
  with tarfile.open(archive,'w:gz') as t:
   info=tarfile.TarInfo('../outside');info.size=4;t.addfile(info,io.BytesIO(b'evil'))
  with self.assertRaises(tarfile.FilterError):m.restore(self.c,archive,self.home/'restore')
  self.assertFalse((self.home/'outside').exists())
 def test_restore_never_overwrites_live_state(self):
  dest=self.home/'restore';dest.mkdir();(dest/'keep').write_text('keep')
  with self.assertRaises(ValueError):m.restore(self.c,'unused',dest)
 def test_running_work_blocks_lifecycle_changes(self):
  with sqlite3.connect(pathlib.Path(self.c['workspace'])/'tasks/state.sqlite3') as c:c.execute('create table tasks(state text)');c.execute("insert into tasks values('running')")
  self.assertTrue(m.active_tasks(self.c))
 def test_failed_upgrade_restores_previous_config_and_current(self):
  old={**self.c,'release':str(self.home/'previous')};pathlib.Path(old['release']).mkdir();pathlib.Path(old['prefix']).mkdir();m.private(self.config/'installation.json',json.dumps(old));m.private(self.config/'runtime.env','original')
  def broken(args):m.private(self.config/'runtime.env','changed');raise ValueError('simulated build failure')
  with patch.object(m,'install_impl',side_effect=broken),patch.object(pathlib.Path,'home',return_value=self.home):
   with self.assertRaises(ValueError):m.install(SimpleNamespace(configure_only=True))
  self.assertEqual((self.config/'runtime.env').read_text(),'original');self.assertEqual((pathlib.Path(old['prefix'])/'current').resolve(),pathlib.Path(old['release']))
 def test_refuses_dangerous_paths(self):
  for value in ['/','/home','/tmp/evil\npath']:
   with self.assertRaises(ValueError):m.safe_path(value)

 def test_installed_roots_and_unit_namespace_are_explicit(self):
  env=m.config_env(self.c)
  self.assertEqual(env['ACC_ROOTS_FILE'],str(self.config/'workspace-roots.json'))
  self.assertEqual(env['ACC_UNIT_PREFIX'],'adcc-task@')
  self.assertEqual(env['AGENT_U_WORKTREES'],str(pathlib.Path(self.c['workspace'])/'worktrees'))

 def test_generated_service_passes_systemd_path_validation(self):
  import shutil,subprocess
  if not shutil.which('systemd-analyze'):self.skipTest('systemd-analyze unavailable')
  with patch.object(pathlib.Path,'home',return_value=self.home):units=m.services(self.c)
  result=subprocess.run(['systemd-analyze','verify',str(units/'adcc-worker.service')],capture_output=True,text=True)
  self.assertEqual(result.returncode,0,result.stderr)
  self.assertNotIn('EnvironmentFile= path is not absolute',result.stderr)
  self.assertIn('WorkingDirectory='+str(pathlib.Path(self.c['prefix'])/'current'),(units/'adcc-worker.service').read_text())

 def test_policy_and_routing_do_not_inherit_another_install(self):
  with patch.dict(os.environ,{'ACC_POLICY_FILE':'/tmp/unrelated-policy.json','ACC_ROUTING_FILE':'/tmp/unrelated-routing.json'}):env=m.config_env(self.c)
  self.assertEqual(env['ACC_POLICY_FILE'],str(self.config/'policy.json'))
  self.assertEqual(env['ACC_ROUTING_FILE'],str(self.config/'routing.json'))
  self.assertEqual(env['ADCC_CONFIG'],str(self.config))
