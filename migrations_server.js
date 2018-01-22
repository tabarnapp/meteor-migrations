/*
  Adds migration capabilities. Migrations are defined like:

  Migrations.add({
    up: function() {}, //*required* code to run to migrate upwards
    version: 1, //*required* number to identify migration order
    down: function() {}, //*optional* code to run to migrate downwards
    name: 'Something' //*optional* display name for the migration
  });

  The ordering of migrations is determined by the version you set.

  To run the migrations, set the MIGRATE environment variable to either
  'latest' or the version number you want to migrate to. Optionally, append
  ',exit' if you want the migrations to exit the meteor process, e.g if you're
  migrating from a script (remember to pass the --once parameter).

  e.g:
  MIGRATE="latest" mrt # ensure we'll be at the latest version and run the app
  MIGRATE="latest,exit" mrt --once # ensure we'll be at the latest version and exit
  MIGRATE="2,exit" mrt --once # migrate to version 2 and exit

  Note: Migrations will lock ensuring only 1 app can be migrating at once. If
  a migration crashes, the control record in the migrations collection will
  remain locked and at the version it was at previously, however the db could
  be in an inconsistant state.
*/

// since we'll be at version 0 by default, we should have a migration set for
// it.

var DEFAULT = "default";
var DefaultMigration = { version: 0, up: function() {} };

Migrations = {
  _channels : {
    [DEFAULT] : [ DefaultMigration ],
  },
  options: {
    // false disables logging
    log: true,
    // null or a function
    logger: null,
    // enable/disable info log "already at latest."
    logIfLatest: true,
    // migrations collection name
    collectionName: 'migrations',
  },
  config: function(opts) {
    this.options = _.extend({}, this.options, opts);
  },
};

/*
  Logger factory function. Takes a prefix string and options object
  and uses an injected `logger` if provided, else falls back to
  Meteor's `Log` package.
  Will send a log object to the injected logger, on the following form:
    message: String
    level: String (info, warn, error, debug)
    tag: 'Migrations'
*/
function createLogger(prefix) {
  check(prefix, String);

  // Return noop if logging is disabled.
  if (Migrations.options.log === false) {
    return function() {};
  }

  return function(level, message) {
    check(level, Match.OneOf('info', 'error', 'warn', 'debug'));
    check(message, String);

    var logger = Migrations.options && Migrations.options.logger;

    if (logger && _.isFunction(logger)) {
      logger({
        level: level,
        message: message,
        tag: prefix,
      });
    } else {
      Log[level]({ message: prefix + ': ' + message });
    }
  };
}

var log;

Meteor.startup(function() {
  var options = Migrations.options;

  // collection holding the control record
  Migrations._collection = new Mongo.Collection(options.collectionName);
  
  Migrations._collection.find({}).fetch().forEach( (e) => {
    console.log("e",e._id, e.locked); 
  });
  log = createLogger('Migrations');

  [ 'info', 'warn', 'error', 'debug' ].forEach(function(level) {
    log[level] = _.partial(log, level);
  }); 
  console.log("process", process.env.MIGRATE); 
  if (process.env.MIGRATE)  {
    Migrations.migrateTo(process.env.MIGRATE);
  }
});

// Add a new migration:
// {up: function *required
//  version: Number *required
//  down: function *optional
//  name: String *optional
// }
Migrations.add = function(migration, channel = DEFAULT ) {

  if (typeof migration.up !== 'function') {
    throw new Meteor.Error('Migration must supply an up function.');
  };

  if (typeof migration.version !== 'number') {
    throw new Meteor.Error('Migration must supply a version number.');
  }

  if (migration.version <= 0) {
    throw new Meteor.Error('Migration version must be greater than 0');
  }

  // Freeze the migration object to make it hereafter immutable
  Object.freeze(migration);

  if ( !this._channels[channel] ) {
    this._channels[channel] = [ DefaultMigration ];
  };
  this._channels[channel].push(migration);
  this._channels[channel] = _.sortBy(this._channels[channel], function(m) {
    return m.version;
  });
};

// Migrations.migrateTo = function(command, channel = DEFAULT){
//   console.log("Im only logger ", command," ", channel); 
// }; 

// Attempts to run the migrations using command in the form of:
// e.g 'latest', 'latest,exit', 2
// use 'XX,rerun' to re-run the migration at that version
Migrations.migrateTo = function(command, channel = DEFAULT) {
  console.log("Dont migrate anything temporary");

  if ( !this._channels[channel]) {
    throw new Error('Cannot migrate on unknow channel: ' + channel );
  };

  if (_.isUndefined(command) || command === '' || this._channels[channel].length === 0) {
    throw new Error('Cannot migrate using invalid command: ' + command);
  };

  if (typeof command === 'number') {
    var version = command;
  } else {
    var version = command.split(',')[0]; //.trim();
    var subcommand = command.split(',')[1]; //.trim();
  }

  if (version === 'latest') {
    log.info(`Migrating to latest \n with :  ${this._channels[channel]} \n and : ${_.last(this._channels[channel]).version}`)
    this._migrateTo(_.last(this._channels[channel]).version, false, channel );
  } else {
    this._migrateTo(parseInt(version), subcommand === 'rerun');
  }

  // remember to run meteor with --once otherwise it will restart
  if (subcommand === 'exit') process.exit(0);
};

// just returns the current version
Migrations.getVersion = function(channel = DEFAULT) {
  return this._getControl(channel).version;
};

// migrates to the specific version passed in
Migrations._migrateTo = function(version, rerun, channel = DEFAULT) {
  log.info(`Migrating to ${version} ${channel}` );
  var self = this;
  var control = this._getControl(channel); // Side effect: upserts control document.
  var currentVersion = control.version;

  if (lock(channel) === false) {
    log.info('Not migrating, control is locked.');
    return;
  }

  if (rerun) {
    log.info('Rerunning version ' + version);
    migrate('up', this._findIndexByVersion(version,channel));
    log.info('Finished migrating.');
    unlock(channel);
    return;
  }
  if (currentVersion === version) {
    if (Migrations.options.logIfLatest) {
      log.info('Not migrating, ' + channel + ' already at version ' + version);
    }
    unlock(channel);
    return;
  }

  var startIdx = this._findIndexByVersion(currentVersion,channel);
  var endIdx = this._findIndexByVersion(version,channel);

  // log.info('startIdx:' + startIdx + ' endIdx:' + endIdx);
  log.info(
    'Migrating from version ' +
      this._channels[channel][startIdx].version +
      ' -> ' +
      this._channels[channel][endIdx].version
    );

  // run the actual migration
  function migrate(direction, idx) {

    var migration = self._channels[channel][idx];

    if (typeof migration[direction] !== 'function') {
      unlock(channel);
      throw new Meteor.Error(
        'Cannot migrate ' + direction + ' on version ' + migration.version
      );
    }

    function maybeName() {
      return migration.name ? ' (' + migration.name + ')' : '';
    }

    log.info(
      'Running ' +
        direction +
        '() on version ' +
        migration.version +
        maybeName()
    );

    migration[direction](migration);
  }

  // Returns true if lock was acquired.
  function lock() {
    log.info('Locking channel' + channel);
    // This is atomic. The selector ensures only one caller at a time will see
    // the unlocked control, and locking occurs in the same update's modifier.
    // All other simultaneous callers will get false back from the update.
    
    self._collection.find({locked : false}).fetch().forEach( (e) => {
      console.log("e",e._id, e.locked); 
    });

    return (
      self._collection.update(
        { _id: 'control_' + channel, locked: false },
        { $set: { locked: true, lockedAt: new Date() } }
      ) === 1
    );
  }

  // Side effect: saves version.
  function unlock() {
    self._setControl({ locked: false, version: currentVersion, channel: channel });
  }

  if (currentVersion < version) {
    for (var i = startIdx; i < endIdx; i += 1) {
      migrate('up', i + 1, channel);
      currentVersion = self._channels[channel][i + 1].version;
    }
  } else {
    for (var i = startIdx; i > endIdx; i-=1) {
      migrate('down', i, channel);
      currentVersion = self._channels[channel][i - 1].version;
    }
  }

  unlock(channel);
  log.info('Finished migrating.');
};

// gets the current control record, optionally creating it if non-existant
Migrations._getControl = function(channel = DEFAULT ) {
  var control = this._collection.findOne({ _id: 'control_' + channel });

  return control || this._setControl({ version: 0, locked: false, channel: channel });
};

// sets the control record
Migrations._setControl = function(control) {
  // be quite strict
  log.info('setting control' + control.channel + control.locked); 
  check(control.version, Number);
  check(control.locked, Boolean);

  this._collection.update(
    { _id: 'control_' + control.channel },
    { $set: { version: control.version, locked: control.locked } },
    { upsert: true }
   );

  return control;
};

// returns the migration index in channel list or throws if not found
Migrations._findIndexByVersion = function(version, channel = DEFAULT) {
  for (var i = 0; i < this._channels[channel].length; i++) {
    if (this._channels[channel][i].version === version) return i;
  }

  throw new Meteor.Error("Can't find migration version " + version);
};

//reset (mainly intended for tests)
Migrations._reset = function() {
  this._channels = {
    [DEFAULT] : [{ version: 0, up: function() {} }],
  };
  this._collection.remove({});
};

// unlock control
Migrations.unlock = function(channel = DEFAULT ) {
  this._collection.update({ _id: 'control_' + channel }, { $set: { locked: false } });
};
