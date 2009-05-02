package gw.db

uses java.sql.*
uses java.util.*
uses java.lang.CharSequence
uses gw.lang.reflect.*
uses gw.lang.reflect.gs.*
uses gw.lang.parser.*
uses gw.util.concurrent.LazyVar
uses gw.lang.reflect.MethodInfoBuilder

internal class DBTypeInfo extends BaseTypeInfo {

	var _properties : Map<String, IPropertyInfo>
	var _arrayProperties = new LazyVar<Map<String, IPropertyInfo>>() {
		override function init() : Map<String, IPropertyInfo> {
			return makeArrayProperties()
		}
	}
	var _getMethod : IMethodInfo
	var _updateMethod : IMethodInfo
	var _deleteMethod : IMethodInfo
	var _findMethod : IMethodInfo
	var _findWithSqlMethod : IMethodInfo
	var _ctor : IConstructorInfo
	
	construct(type : DBType) {
		super(type)
		
		_getMethod = new MethodInfoBuilder().withName("get").withStatic()
			.withParameters({new ParameterInfoBuilder().withName("id").withType(long)})
			.withReturnType(type)
			.withCallHandler(\ ctx, args -> selectById(args[0] as java.lang.Long)).build(this)
		_updateMethod = new MethodInfoBuilder().withName("update")
			.withCallHandler(\ ctx, args -> {
			  (ctx as IHasImpl)._impl.update()
			  return null
			}).build(this)
		_deleteMethod = new MethodInfoBuilder().withName("delete")
			.withCallHandler(\ ctx, args -> {
			  (ctx as IHasImpl)._impl.delete()
			  return null
			}).build(this)
		_findWithSqlMethod = new MethodInfoBuilder().withName("findWithSql").withStatic()
			.withParameters({new ParameterInfoBuilder().withName("sql").withType(String)})
			.withReturnType(List.Type.GenericType.getParameterizedType({type}))
			.withCallHandler(\ ctx, args -> findWithSql(args[0] as String)).build(this)
		_findMethod = new MethodInfoBuilder().withName("find").withStatic()
		    .withParameters({new ParameterInfoBuilder().withName("template").withType(type)})
		    .withReturnType(List.Type.GenericType.getParameterizedType({type}))
		    .withCallHandler(\ ctx, args -> findFromTemplate((args[0] as IHasImpl)._impl)).build(this)

		_properties = new HashMap<String, IPropertyInfo>()
		using(var con = connect()) {
			using(var cols = con.MetaData.getColumns(null, null, type.RelativeName, null)) {
				cols.first()
				while(!cols.isAfterLast()) {
					var col = cols.getString("COLUMN_NAME")
					var colType = cols.getInt("DATA_TYPE")
					var prop = makeProperty(col, colType)
					_properties.put(prop.Name, prop)
					cols.next()
				}
			}
		}

		_ctor = new ConstructorInfoBuilder()
			.withConstructorHandler(new IConstructorHandler() {
				override function newInstance(args : Object[]) : Object {
					return create()
				}
				override function newInstance(encl : IGScriptClassInstance, args : Object[]) : Object {
					return newInstance(args)
				}
			})
			.build(this)
	}
	
	override property get Properties() : List<IPropertyInfo> {
		var props = new ArrayList<IPropertyInfo>(_properties.values())
		props.addAll(_arrayProperties.get().values())
		return props
	}
	
	override function getProperty(propName : CharSequence) : IPropertyInfo {
		var prop = _properties.get(propName.toString())
		if(prop == null) {
			prop = _arrayProperties.get().get(propName.toString())
		}
		return prop
	}
	
	override function getRealPropertyName(propName : CharSequence) : CharSequence {
		for(key in _properties.keySet()) {
			if(key.equalsIgnoreCase(propName)) {
				return key
			}
		}
		for(key in _arrayProperties.get().keySet()) {
			if(key.equalsIgnoreCase(propName)) {
				return key
			}
		}
		return null
	}
	
	override property get Methods() : List<IMethodInfo> {
		return {_getMethod, _updateMethod, _deleteMethod, _findWithSqlMethod, _findMethod}
	}
	
	override function getMethod(methodName : CharSequence, params : IType[]) : IMethodInfo {
		if(methodName == "get" && params == {long}) {
			return _getMethod
		} else if(methodName == "update" && params.IsEmpty) {
			return _updateMethod
		} else if(methodName == "delete" && params.IsEmpty) {
			return _deleteMethod
		} else if(methodName == "findWithSql" && params == {String}) {
			return _findWithSqlMethod
		}
		return null
	}
	
	override function getCallableMethod(methodName : CharSequence, params : IType[]) : IMethodInfo {
		return getMethod(methodName, params)
	}
	
	override property get Constructors() : List<IConstructorInfo> {
		return {_ctor}
	}
	
	override function getConstructor(params : IType[]) : IConstructorInfo {
		if(params.IsEmpty) {
			return _ctor
		} else {
			return null
		}
	}
	
	override function getCallableConstructor(params : IType[]) : IConstructorInfo {
		return getConstructor(params)
	}
	
	private function connect() : Connection {
		return (OwnersIntrinsicType as IDBType).Connection.connect()
	}
	
	internal function selectById(id : long) : CachedDBObject {
		var obj : CachedDBObject = null
		using(var con = connect(),
			var statement = con.createStatement()) {
			statement.executeQuery("select * from \"${OwnersIntrinsicType.RelativeName}\" where \"id\" = ${id}")
			using(var result = statement.ResultSet) {
				if(result.first()) {
					obj = buildObject(result)
				}
			}
		}
		return obj
	}
	
	internal function findFromTemplate(template : CachedDBObject) : List<CachedDBObject> {
	    var whereClause = new ArrayList<String>()
	    if(template != null) {
		    for(columnName in template.Columns.keySet()) {
		        var columnVal = template.Columns[columnName]
		        if(columnVal != null) {
		            var value : String
	                value = "'${columnVal.toString().replace("'", "\\'")}'"
		            whereClause.add("\"${columnName}\" = ${value}")
		        }
		    }
	    }
	    if(whereClause.Empty) {
			return findWithSql("select * from \"${OwnersIntrinsicType.RelativeName}\"")
	    } else {
			return findWithSql("select * from \"${OwnersIntrinsicType.RelativeName}\" where ${whereClause.join(" and ")}")
	    }
	}
	
	internal function findInDb(props : List<IPropertyInfo>, args : Object[]) : List<CachedDBObject> {
		var whereClause = new ArrayList<String>()
		props.eachWithIndex(\ p, i -> {
			if(p typeis DBPropertyInfo) {
				var value : String
				if(p.ColumnName.endsWith("_id")) {
					value = (typeof args[i]).TypeInfo.getProperty("id").Accessor.getValue(args[i])
				} else {
					value = "'${args[i].toString().replace("'", "\\'")}'"
				}
				var colName = p.ColumnName
				whereClause.add("\"${colName}\" = ${value}")
			}
		})
		return findWithSql("select * from \"${OwnersIntrinsicType.RelativeName}\" where ${whereClause.join(" and ")}")
	}
	
	internal function findWithSql(sql : String) : List<CachedDBObject> {
		var objs = new ArrayList<CachedDBObject>()
		using(var con = connect(),
			var statement = con.createStatement()) {
			statement.executeQuery(sql)
			using(var result = statement.ResultSet) {
				if(result.first()) {
					objs = buildObjects(result)
				}
			}
		}
		return objs.freeze()
	}
	
	private function buildObjects(result : ResultSet) : ArrayList<CachedDBObject> {
		var objs = new ArrayList<CachedDBObject>()
		while(!result.isAfterLast()) {
			objs.add(buildObject(result))
			result.next()
		}
		return objs
	}
	
	private function buildObject(result : ResultSet) : CachedDBObject {
		var obj = new CachedDBObject(OwnersIntrinsicType.RelativeName, OwnersIntrinsicType.TypeLoader as DBTypeLoader, (OwnersIntrinsicType as DBType).Connection, false)
		for(prop in Properties.whereTypeIs(DBPropertyInfo)) {
		    var resultObject = result.getObject(prop.ColumnName)
		    if(prop.ColumnName == "id") {
		        obj.Columns.put(prop.ColumnName, resultObject as long)
		    } else {
				obj.Columns.put(prop.ColumnName, resultObject)
		    }
		}
		return obj
	}
	
	internal function create(): CachedDBObject {
		return new CachedDBObject(OwnersIntrinsicType.RelativeName, OwnersIntrinsicType.TypeLoader as DBTypeLoader, (OwnersIntrinsicType as DBType).Connection, true)
	}
	
	private function makeArrayProperties() : Map<String, IPropertyInfo> {
		var arrayProps = new HashMap<String, IPropertyInfo>()
		for(fkTable in (OwnersIntrinsicType as DBType).Connection.getFKs(OwnersIntrinsicType.RelativeName)) {
			var arrayProp = makeArrayProperty(fkTable)
			arrayProps.put(arrayProp.Name, arrayProp)
		}
		return arrayProps
	}

	private function makeProperty(propName : String, type : int) : DBPropertyInfo {
		return new DBPropertyInfo(this, propName, type)
	}
	
	private function makeArrayProperty(fkTable : String) : IPropertyInfo {
		var namespace = (OwnersIntrinsicType as DBType).Connection.Namespace
		var fkType = OwnersIntrinsicType.TypeLoader.getType("${namespace}.${fkTable}")
		return new PropertyInfoBuilder().withName("${fkTable}s").withType(List.Type.GenericType.getParameterizedType({fkType}))
			.withWritable(false).withAccessor(new IPropertyAccessor() {
				override function getValue(ctx : Object) : Object {
					return (fkType.TypeInfo as DBTypeInfo).findInDb({fkType.TypeInfo.getProperty(outer.OwnersIntrinsicType.RelativeName)}, {ctx})
				}
				override function setValue(ctx : Object, value : Object) {
				}
			}).build(this)
	}
	
}