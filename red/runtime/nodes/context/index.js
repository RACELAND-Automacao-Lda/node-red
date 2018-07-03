/**
 * Copyright JS Foundation and other contributors, http://js.foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/

var clone = require("clone");
var log = require("../../log");
var memory = require("./memory");

var settings;

// A map of scope id to context instance
var contexts = {};

// A map of store name to instance
var stores = {};

// Whether there context storage has been configured or left as default
var hasConfiguredStore = false;

var defaultStore = "_";

function init(_settings) {
    settings = _settings;
    stores = {};
    var seed = settings.functionGlobalContext || {};
    contexts['global'] = createContext("global",seed);
    stores["_"] = new memory();
}

function load() {
    return new Promise(function(resolve,reject) {
        // load & init plugins in settings.contextStorage
        var plugins = settings.contextStorage;
        var defaultIsAlias = false;
        var promises = [];
        if (plugins) {
            var hasDefault = plugins.hasOwnProperty('default');
            var defaultName;
            for (var pluginName in plugins) {
                if (plugins.hasOwnProperty(pluginName)) {
                    // "_" is a reserved name - do not allow it to be overridden
                    if (pluginName === "_") {
                        continue;
                    }

                    // Check if this is setting the 'default' context to be a named plugin
                    if (pluginName === "default" && typeof plugins[pluginName] === "string") {
                        // Check the 'default' alias exists before initialising anything
                        if (!plugins.hasOwnProperty(plugins[pluginName])) {
                            return reject(new Error(log._("context.error-invalid-default-module", {storage:plugins["default"]})));
                        }
                        defaultIsAlias = true;
                        continue;
                    }
                    if (!hasDefault && !defaultName) {
                        defaultName = pluginName;
                    }
                    var plugin;
                    if (plugins[pluginName].hasOwnProperty("module")) {
                        // Get the provided config and copy in the 'approved' top-level settings (eg userDir)
                        var config = plugins[pluginName].config || {};
                        copySettings(config, settings);

                        if (typeof plugins[pluginName].module === "string") {
                            // This config identifies the module by name - assume it is a built-in one
                            // TODO: check it exists locally, if not, try to require it as-is
                            try {
                                plugin = require("./"+plugins[pluginName].module);
                            } catch(err) {
                                return reject(new Error(log._("context.error-module-not-loaded", {module:plugins[pluginName].module})));
                            }
                        } else {
                            // Assume `module` is an already-required module we can use
                            plugin = plugins[pluginName].module;
                        }
                        try {
                            // Create a new instance of the plugin by calling its module function
                            stores[pluginName] = plugin(config);
                        } catch(err) {
                            return reject(new Error(log._("context.error-loading-module",{module:pluginName,message:err.toString()})));
                        }
                    } else {
                        // Plugin does not specify a 'module'
                        return reject(new Error(log._("context.error-module-not-defined", {storage:pluginName})));
                    }
                }
            }

            // Open all of the configured contexts
            for (var plugin in stores) {
                if (stores.hasOwnProperty(plugin)) {
                    promises.push(stores[plugin].open());
                }
            }

            // There is a 'default' listed in the configuration
            if (hasDefault) {
                // If 'default' is an alias, point it at the right module - we have already
                // checked that it exists. If it isn't an alias, then it will
                // already be set to a configured store
                if (defaultIsAlias) {
                    stores["default"] =  stores[plugins["default"]];
                }
                stores["_"] = stores["default"];
            } else if (defaultName) {
                // No 'default' listed, so pick first in list as the default
                stores["default"] = stores[defaultName];
                stores["_"] = stores["default"];
            } // else there were no stores list the config object - fall through
              // to below where we default to a memory store
        }

        if (promises.length === 0) {
            // No stores have been configured. Setup the default as an instance
            // of memory storage
            stores["_"] = memory();
            stores["default"] = stores["_"];
            promises.push(stores["_"].open())
        } else {
            // if there's configured storage then the lifecycle is slightly different
            // - specifically, we don't delete node context on redeploy
            hasConfiguredStore = true;
        }
        return resolve(Promise.all(promises));
    });
}

function copySettings(config, settings){
    var copy = ["userDir"]
    config.settings = {};
    copy.forEach(function(setting){
        config.settings[setting] = clone(settings[setting]);
    });
}

function getContextStorage(storage) {
    if (stores.hasOwnProperty(storage)) {
        // A known context
        return stores[storage];
    } else if (stores.hasOwnProperty("default")) {
        // Not known, but we have a default to fall back to
        return stores["default"];
    } else {
        // Not known and no default configured
        var contextError = new Error(log._("context.error-use-undefined-storage", {storage:storage}));
        contextError.name = "ContextError";
        throw contextError;
    }
}


function createContext(id,seed) {
    // Seed is only set for global context - sourced from functionGlobalContext
    var scope = id;
    var obj = seed || {};
    var seedKeys;
    if (seed) {
        seedKeys = Object.keys(seed);
    }
    obj.get = function(key, storage, callback) {
        var context;
        if (!storage && !callback) {
            context = stores["_"];
        } else {
            if (typeof storage === 'function') {
                callback = storage;
                storage = "default";
            }
            if (typeof callback !== 'function'){
                throw new Error("Callback must be a function");
            }
            context = getContextStorage(storage);
        }
        if (seed) {
            // Get the value from the underlying store. If it is undefined,
            // check the seed for a default value.
            if (callback) {
                context.get(scope,key,function(err, v) {
                    if (v === undefined) {
                        callback(err, seed[key]);
                    } else {
                        callback(err, v);
                    }
                })
            } else {
                // No callback, attempt to do this synchronously
                var storeValue = context.get(scope,key);
                if (storeValue === undefined) {
                    return seed[key];
                } else {
                    return storeValue;
                }
            }
        } else {
            return context.get(scope, key, callback);
        }
    };
    obj.set = function(key, value, storage, callback) {
        var context;
        if (!storage && !callback) {
            context = stores["_"];
        } else {
            if (typeof storage === 'function') {
                callback = storage;
                storage = "default";
            }
            if (callback && typeof callback !== 'function') {
                throw new Error("Callback must be a function");
            }
            context = getContextStorage(storage);
        }
        context.set(scope, key, value, callback);
    };
    obj.keys = function(storage, callback) {
        var context;
        if (!storage && !callback) {
            context = stores["_"];
        } else {
            if (typeof storage === 'function') {
                callback = storage;
                storage = "default";
            }
            if (typeof callback !== 'function') {
                throw new Error("Callback must be a function");
            }
            context = getContextStorage(storage);
        }
        if (seed) {
            if (callback) {
                context.keys(scope, function(err,keys) {
                    callback(err,Array.from(new Set(seedKeys.concat(keys)).keys()));
                });
            } else {
                var keys = context.keys(scope);
                return Array.from(new Set(seedKeys.concat(keys)).keys())
            }
        } else {
            return context.keys(scope, callback);
        }
    };
    return obj;
}

function getContext(localId,flowId) {
    var contextId = localId;
    if (flowId) {
        contextId = localId+":"+flowId;
    }
    if (contexts.hasOwnProperty(contextId)) {
        return contexts[contextId];
    }
    var newContext = createContext(contextId);
    if (flowId) {
        newContext.flow = getContext(flowId);
    }
    newContext.global = contexts['global'];
    contexts[contextId] = newContext;
    return newContext;
}

function deleteContext(id,flowId) {
    if(!hasConfiguredStore){
        // only delete context if there's no configured storage.
        var contextId = id;
        if (flowId) {
            contextId = id+":"+flowId;
        }
        delete contexts[contextId];
        return stores["_"].delete(contextId);
    }else{
        return Promise.resolve();
    }
}

function clean(flowConfig) {
    var promises = [];
    for(var plugin in stores){
        if(stores.hasOwnProperty(plugin)){
            promises.push(stores[plugin].clean(Object.keys(flowConfig.allNodes)));
        }
    }
    for (var id in contexts) {
        if (contexts.hasOwnProperty(id) && id !== "global") {
            var idParts = id.split(":");
            if (!flowConfig.allNodes.hasOwnProperty(idParts[0])) {
                delete contexts[id];
            }
        }
    }
    return Promise.all(promises);
}

function close() {
    var promises = [];
    for(var plugin in stores){
        if(stores.hasOwnProperty(plugin)){
            promises.push(stores[plugin].close());
        }
    }
    return Promise.all(promises);
}

module.exports = {
    init: init,
    load: load,
    get: getContext,
    delete: deleteContext,
    clean: clean,
    close: close
};