var express = require('express'),
    fs = require('fs'),
    lunr = require('lunr');

var indent = 4;
var site_url = 'http://swiftdoc.org/';
var api_url  = 'http://api.swiftdoc.org/';
var data = JSON.parse(fs.readFileSync('swiftdoc.json', 'utf8'));



// -----------------------------------------------------------------------
// Array extensions 

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



// -----------------------------------------------------------------------
// Build indexes and item arrays

// create the lunr search index
var searchIndex = lunr(function () {
    this.field('name', 100);
    this.field('comment');
    this.ref('id');
});

// convert big data structure into a simple array
var itemsAsArray = Object.keys(data.types)
                         .sort()
                         .map(function(el) { return data.types[el] });
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
            'all_urls_url': 'http://api.swiftdoc.org/urls',
            'search_url': 'http://api.swiftdoc.org/search?q={query}',
        };
    response.send(JSON.stringify(routes, null, indent));
});

// URLs for each item
app.get('/urls', function(request, response) {
    var result = itemsAsArray.reduce(function (p, c) {
        p[c.name] = site_url + pathForItem(c);
        return p;
    }, { });
    response.send(JSON.stringify(result, null, indent));
});

// search results
app.get('/search', function(request, response) {
    var results = searchIndex.search(request.query['q']).map(function(result) {
        var doc = itemDocuments[result.ref];
        return {
            title: doc.title,
            site_url: site_url + pathForItem(itemsAsArray[doc.index]),
            // api_url: api_url + pathForItem(itemsAsArray[doc.index]),
            // comment: doc.comment,
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

// start server
app.listen(app.get('port'), function() {
    console.log("SwiftDoc API is running at localhost:" + app.get('port'));
});



// -----------------------------------------------------------------------
// Utility functions

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


