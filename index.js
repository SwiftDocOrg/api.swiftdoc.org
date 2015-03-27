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

console.log(itemsAsArray);

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
                    name: item.name || item.kind,
                    comment: item.comment,
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
app.get('/*', function(req, res, next) {
  res.contentType('application/json');
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
    var results = itemsAsArray.reduce(itemToTitleAndPath(api_url), { });
    
    response.send(JSON.stringify(results, null, indent));
});

// search results
app.get('/search', function(request, response) {
    var results = searchIndex.search(request.query['q']).map(function(result) {
        var doc = itemDocuments[result.ref];
        return {
            title: doc.title,
            site_url: site_url.addPathComponent(pathForItem(itemsAsArray[doc.index])),
            // api_url: api_url.addPathComponent(pathForItem(itemsAsArray[doc.index])),
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

app.get(/^\/(protocol|type)\/?$/, function(request, response) {
    var isProtocol = request.params[0] == 'protocol';
    var results = typesAsArray.filter(function(c) {
        return isProtocol ^ (c.kind != 'protocol');
    }).reduce(itemToTitleAndPath(api_url), { });
    
    response.send(JSON.stringify(results, null, indent));
});

app.get(/^\/(operator|func)\/?$/, function(request, response) {
    var results = itemsAsArray.filter(function(c) {
        return (c.kind == request.params[0]);
    }).reduce(itemToTitleAndPath(api_url), { });
    
    response.send(JSON.stringify(request.params, null, indent));
});

app.get('/global', function(request, response) {
    var results = itemsAsArray.filter(function(c) {
        return ((c.kind == 'typealias') || (c.kind == 'var'));
    }).reduce(itemToTitleAndPath(api_url), { });
    
    response.send(JSON.stringify(request.params, null, indent));
});

app.get(/^\/(protocol|type|operator|func|global)\/([^\/]*)\/?$/, function(request, response) {
    response.send(JSON.stringify(request.params, null, indent));
});


// start server
app.listen(app.get('port'), function() {
    console.log("SwiftDoc API is running at localhost:" + app.get('port'));
});



// -----------------------------------------------------------------------
// Utility functions

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
            return 'global/alias/';
        case 'var':
            return 'global/var/';
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


