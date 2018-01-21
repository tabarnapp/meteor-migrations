Package.describe({
  summary: 'Define and run db migrations.',
  version: '1.0.2',
  name: 'tabarnapp:migrations',
  git: 'https://github.com/percolatestudio/meteor-migrations.git',
});

Package.on_use(function(api) {
  api.versionsFrom('METEOR@1.5');
  api.use('ecmascript');
  api.use([ 'underscore', 'check', 'mongo', 'logging' ], 'server');
  api.addFiles([ 'migrations_server.js' ], 'server');
  api.export('Migrations', 'server');
});

Package.on_test(function(api) {
  api.use('ecmascript');
  api.use([ 'tabarnapp:migrations', 'tinytest' ]);
  // api.addFiles('migrations_tests.js', [ 'server' ]);
});
