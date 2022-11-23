"use strict";
const mongoose = require('mongoose');
const hm = require('./history-model');
const async = require('async')
const _ = require('lodash');

// Get the difference between two objects
const getDiff = (curr, prev) => {
  function changes(object, base) {
    return _.transform(object, (result, value, key) => {
      if (!_.isEqual(value, base[key])) {
        result[key] =
          _.isObject(value) && _.isObject(base[key])
            ? changes(value, base[key])
            : value
      }
    })
  }
  return changes(curr, prev)
}

module.exports = function historyPlugin(schema, options) {
  const customCollectionName = options && options.customCollectionName;
  const customDiffAlgo = options && options.customDiffAlgo;
  const diffOnly = options && options.diffOnly;
  const metadata = options && options.metadata;

  // Clear all history collection from Schema
  schema.statics.historyModel = function () {
    return hm.HistoryModel(hm.historyCollectionName(this.collection.name, customCollectionName), options);
  };

  // Clear all history documents from history collection
  schema.statics.clearHistory = function (callback) {
    const History = hm.HistoryModel(hm.historyCollectionName(this.collection.name, customCollectionName), options);
    History.remove({}, function (err) {
      callback(err);
    });
  };

  // Save original data
  schema.post('init', function () {
    if (diffOnly) {
      this._original = this.toObject();
    }
  });

  function setMetadata(original, d, historyDoc, callback) {
    async.each(metadata, (m, cb) => {
      if (typeof (m.value) === 'function') {
        if (m.value.length === 3) {
          /** async function */
          m.value(original, d, function (err, data) {
            if (err) cb(err);
            historyDoc[m.key] = data;
            cb();
          })
        } else {
          historyDoc[m.key] = m.value(original, d);
          cb();
        }
      } else {
        historyDoc[m.key] = d ? d[m.value] : null;
        cb();
      }
    }, callback)
  }


  // Create a copy when insert or update, or a diff log
  schema.pre('save', function (next) {
    let historyDoc = {};

    if (diffOnly && !this.isNew) {
      var original = this._original;
      delete this._original;
      var d = this.toObject();
      var diff = {};
      diff['_id'] = d['_id'];
      for (var k in d) {
        if (customDiffAlgo) {
          var customDiff = customDiffAlgo(k, d[k], original[k]);
          if (customDiff) {
            diff[k] = customDiff.diff;
          }
        } else {
          if (String(d[k]) != String(original[k])) {
            diff[k] = d[k];
          }
        }
      }

      historyDoc = createHistoryDoc(diff, 'update');
    } else {
      var d = this.toObject();
      let operation = this.isNew ? 'insert' : 'update';
      historyDoc = createHistoryDoc(d, operation, this.collection.name);
    }

    saveHistoryModel(original, d, historyDoc, this.collection.name, next);
  });

  // Listen on update
  schema.pre('update', function (next) {
    processUpdate.call(this, next);
  });

  // Listen on updateOne
  schema.pre('updateOne', function (next) {
    processUpdate.call(this, next);
  });

  // Listen on findOneAndUpdate
  schema.pre('findOneAndUpdate', function (next) {
    processUpdate.call(this, next);
  });

  // Create a copy on remove
  schema.pre('remove', function (next) {
    let d = this.toObject();
    let historyDoc = createHistoryDoc(d, 'delete');

    saveHistoryModel(this.toObject(), d, historyDoc, this.collection.name, next);
  });

  // Create a copy on findOneAndRemove
  schema.post('findOneAndRemove', function (doc, next) {
    processRemove.call(this, doc, next);
  });

  function createHistoryDoc(d, operation, model) {
    const { __v, ...doc } = d;

    let historyDoc = {};
    historyDoc['collectionName'] = model;
    historyDoc['time'] = new Date();
    historyDoc['action'] = operation;
    historyDoc['data'] = doc;

    return historyDoc;
  }

  function saveHistoryModel(original, d, historyDoc, collectionName, next) {
    if (metadata) {
      setMetadata(original, d, historyDoc, (err) => {
        if (err) return next(err);
        let history = new hm.HistoryModel(hm.historyCollectionName(collectionName, customCollectionName), options)(historyDoc);
        history.save(next);
      });
    } else {
      let history = new hm.HistoryModel(hm.historyCollectionName(collectionName, customCollectionName), options)(historyDoc);
      history.save(next);
    }
  }

  async function processUpdate(next) {
    try {
      const docToUpdate = await this.model.findOne(this.getQuery());
      const newDoc = this._update
      let d = getDiff(newDoc, docToUpdate)
      d._id = docToUpdate._id;
      d.updatedBy = newDoc.updatedBy && newDoc.updatedBy
      let historyDoc = createHistoryDoc(d, 'update', this.mongooseCollection.collectionName);

      saveHistoryModel(this.toObject, d, historyDoc, this.mongooseCollection.collectionName, next);
    } catch (err) {
      next(err);
    }
  }

  function processRemove(doc, next) {
    let d = doc.toObject();
    let historyDoc = createHistoryDoc(d, 'delete');

    saveHistoryModel(this.toObject, d, historyDoc, this.mongooseCollection.collectionName, next);
  }

};
