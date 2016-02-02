// modules
var express = require('express'),
    fs = require('fs'),
    lunr = require('lunr');

// data
var pjson = require('./package.json'),
    data = require('./swiftdoc.json');

var indent = 4;
var site_url = 'http://swiftdoc.org/';
var api_url  = 'http://api.swiftdoc.org';


// -----------------------------------------------------------------------
// Type extensions 

// returns a new array with only unique elements of the array
Array.prototype.unique = function() {
    return this.reduce(function(p, c) { 
                    if (p.indexOf(c) < 0) p.push(c);
                    return p;
                }, []);
}

// returns a new array with the elements of `arr` appended to the array
Array.prototype.extend = function(arr) {
    this.push.apply(this, arr);
    return this;
}

// returns a new string with `pathComponent` added at the end, handling the slash in between
String.prototype.addPathComponent = function(pathComponent) {
    pathComponent = pathComponent.replace(/^\//, '');
    if (this[this.length - 1] == '/') {
        return this + pathComponent;
    } else{
        return this + '/' + pathComponent;
    }
}

// Array.find polyfill
if (!Array.prototype.find) {
  Array.prototype.find = function(predicate) {
    if (this === null) {
      throw new TypeError('Array.prototype.find called on null or undefined');
    }
    if (typeof predicate !== 'function') {
      throw new TypeError('predicate must be a function');
    }
    var list = Object(this);
    var length = list.length >>> 0;
    var thisArg = arguments[1];
    var value;

    for (var i = 0; i < length; i++) {
      value = list[i];
      if (predicate.call(thisArg, value, i, list)) {
        return value;
      }
    }
    return undefined;
  };
}


// -----------------------------------------------------------------------
// Build indexes and item arrays

// create the lunr search index
var searchIndex = lunr(function () {
    this.field('name', { boost: 100 });
    this.field('comment');
    this.ref('id');
});

// convert big data structure into a simple array
var typesAsArray = Object.keys(data.types)
                         .sort()
                         .map(function(el) { return data.types[el] });
var itemsAsArray = typesAsArray.slice();
itemsAsArray.extend(data.operators);
itemsAsArray.extend(data.functions);
itemsAsArray.extend(data.properties);
itemsAsArray.extend(data.aliases);

// create "documents" that can be indexed by lunr
var itemCount = 0;
var itemDocuments = itemsAsArray.reduce(function (memo, item, index) {
    memo.push({
        id: itemCount++,
        name: item.name,
        comment: item.comment,
        title: titleForItem(item),
        index: index,
    });
    
    // for types & protocols, index sub-items as well
    ['functions', 'properties', 'aliases', 'inits', 'subscripts'].forEach(function(section) {
        if (item[section]) {
            item[section].forEach(function(subitem) {
                memo.push({
                    id: itemCount++,
                    name: subitem.name || subitem.kind,
                    comment: subitem.comment,
                    title: titleForItem(subitem, item.name),
                    index: index,
                });
            });
        }
    });
    
    return memo;
}, []);

// add "documents" to search index
itemDocuments.forEach(function(doc) {
    searchIndex.add(doc);
});



// -----------------------------------------------------------------------
// Express app

// initialize app
var app = express();
app.set('port', (process.env.PORT || 5000));
app.use(express.static(__dirname + '/public'));

// set MIME type for all responses
app.get('/*', function(request, response, next) {
    api_url = 'http://' + request.headers.host;
    response.contentType('application/json');
    next();
});

// provide list of API URLs for root request
app.get('/', function(request, response) {
    var routes = {
            'all_urls_url': api_url.addPathComponent('urls'),
            'api_urls_url': api_url.addPathComponent('api_urls'),
            'search_url': api_url.addPathComponent('search?q={query}'),
            'version_url': api_url.addPathComponent('version'),
        };
    
    response.send(JSON.stringify(routes, null, indent));
});

// URLs for each item at SwiftDoc.org
app.get('/urls', function(request, response) {
    var results = itemsAsArray.reduce(itemToTitleAndPath(site_url), { });
    
    response.send(JSON.stringify(results, null, indent));
});

// URLs for each item in API
app.get('/api_urls', function(request, response) {
    var results = itemsAsArray.reduce(apiItemToTitleAndPath(api_url), { });
    
    response.send(JSON.stringify(results, null, indent));
});

// search results
app.get('/search', function(request, response) {
    var results = searchIndex.search(request.query['q']).map(function(result) {
        var doc = itemDocuments[result.ref];
        return {
            title: doc.title,
            site_url: site_url.addPathComponent(pathForItem(itemsAsArray[doc.index])),
            api_url: api_url.addPathComponent(apiPathForItem(itemsAsArray[doc.index])),
            comment: doc.comment,
            // score: result.score,
        };
    }).sort(function (a, b) {
        if (a.score == b.score) {
            return a.title.length - b.title.length;
        }
        return b.score - a.score;
    });
    response.send(JSON.stringify(results, null, indent));
});

// version for Swift and this API
app.get('/version', function(request, response) {
    var versions = data['version'];
    versions['api'] = pjson['version'];

    response.send(JSON.stringify(versions, null, indent));
});

// list of protocols and types only
app.get(/^\/(protocol|type)\/?$/, function(request, response) {
    var isProtocol = request.params[0] == 'protocol';
    var results = typesAsArray.filter(function(c) {
        return isProtocol ^ (c.kind != 'protocol');
    }).reduce(itemToTitleAndPath(api_url), { });
    
    response.send(JSON.stringify(results, null, indent));
});

// list of operators or global functions only
app.get(/^\/(operator|func)\/?$/, function(request, response) {
    var results = itemsAsArray.filter(function(c) {
        return (c.kind == request.params[0]);
    }).reduce(itemToTitleAndPath(api_url), { });
    
    response.send(JSON.stringify(request.params, null, indent));
});

// list of global declarations (typealiases, basically)
app.get('/global', function(request, response) {
    var results = itemsAsArray.filter(function(c) {
        return ((c.kind == 'typealias') || (c.kind == 'var'));
    }).reduce(itemToTitleAndPath(api_url), { });
    
    response.send(JSON.stringify(request.params, null, indent));
});

// handle request for a specific item
app.get(/^\/(protocol|type|operator|func|global)\/([^\/]*)\/?$/, function(request, response) {
    var result;
    
    switch (request.params[0]) {
        case 'protocol':
        case 'type':
            result = data.types[request.params[1]];
            break;
    
        case 'operator':
            result = data.operators.find(function(element) {
                return element.slug == request.params[1];
            });
            break;
    
        case 'func':
            result = data.functions.filter(function(element) {
                return element.name == request.params[1];
            });
            break;
            
        case 'global':
            result = data.aliases.find(function(element) {
                return element.name == request.params[1];
            });
            break;
            
    }
    if (result) {
        response.send(JSON.stringify(result, null, indent));
    } else {
        response.send(JSON.stringify({ "error": "no match", "request": request.params }, null, indent));
    }
});


// start server
app.listen(app.get('port'), function() {
    console.log("SwiftDoc API is running on port: " + app.get('port'));
});



// -----------------------------------------------------------------------
// Utility functions

function apiPathForItem(item) {
    // slight tweak: global type aliases are all on one page on SwiftDoc.org
    // but are their own results in the API, so get the path but delete
    // the aliases part
    var result = pathForItem(item);
    return result.replace('/aliases/#', '/');
}

function apiItemToTitleAndPath(pathPrefix) {
    var process = function(aggregate, current) {
        aggregate[current.name] = pathPrefix.addPathComponent(apiPathForItem(current));
        return aggregate;
    }
    return process;
}

function itemToTitleAndPath(pathPrefix) {
    var process = function(aggregate, current) {
        aggregate[current.name] = pathPrefix.addPathComponent(pathForItem(current));
        return aggregate;
    }
    return process;
}

function pathForItem(item) {
    switch (item.kind) {
        case 'protocol':
            return 'protocol/' + item.slug + '/';
        case 'enum':
        case 'struct':
        case 'class':
            return 'type/' + item.slug + '/';
        case 'operator':
            return 'operator/' + item.slug + '/';
        case 'func':
            return 'func/' + item.slug + '/';
        case 'typealias':
            return 'global/aliases/#' + item.name;
        default:
            return '/404/';
    }
}

function titleForItem(item, context) {
    var prefix = (!context) ? '' : context + '.';
    var label = '(' + item.kind + ')';
    
    switch (item.kind) {
        case 'protocol':
        case 'enum':
        case 'struct':
        case 'class':
        case 'operator':
        case 'typealias':
            return prefix + item.name + ' ' + label;

        case 'init':
            return ((context) ? context : '') + ' initializer';
        case 'subscript':
            return ((context) ? context : '') + ' subscript';

        case 'func':
            if (!context) label = '(global)';
            else {
                var staticKeyword = (data.types[context].kind == 'class') ? 'class' : 'static';
                if (item.note == 'class') label = '(' + staticKeyword + ' method)';
                else label = '(instance method)';
            }
            
            return prefix + item.name + '() ' + label;

        case 'var':
            if (!context) label = '(global)';
            else {
                var staticKeyword = (data.types[context].kind == 'class') ? 'class' : 'static';
                if (item.note == 'class') label = '(' + staticKeyword + ' property)';
                else label = '(instance property)';
            }
            
            return prefix + item.name + ' ' + label;
        default:
            return item.name + ' (unknown)';
    }
}


