package ronin

uses gw.lang.parser.*
uses gw.lang.parser.expressions.*
uses gw.lang.reflect.*
uses gw.lang.reflect.features.*

uses gw.lang.Deprecated
uses java.net.URLEncoder
uses java.lang.ThreadLocal
uses java.lang.StringBuilder
uses gw.lang.function.IFunction0

class URLUtil {

  static function urlFor(target : MethodReference) : String {
    var prefix = Ronin.CurrentRequest.Prefix
    var url : StringBuilder
    if(prefix != null) {
      url = new StringBuilder(prefix)
    } else {
      url = new StringBuilder()
    }
    url.append(target.MethodInfo.OwnersType.RelativeName).append("/").append(target.MethodInfo.DisplayName)
    if(target.MethodInfo.Parameters.HasElements) {
      url.append("?")
      for(param in target.MethodInfo.Parameters index i) {
        var argValue = target.BoundValues[i]
        if(param.FeatureType.Array) {
          var arrayType = param.FeatureType
          if(argValue != null) {
            var arrayLength = arrayType.getArrayLength(argValue)
            for(j in 0..|arrayLength) {
              var componentValue = arrayType.getArrayComponent(argValue, j)
              if(componentValue != null) {
                if(i > 0 or j > 0) {
                  url.append("&")
                }
                var stringValue = getStringValue(componentValue)
                url.append(URLEncoder.encode(param.Name, "UTF-8")).append("[").append(j).append("]").append("=").append(URLEncoder.encode(stringValue.toString(), "UTF-8"))
              }
            }
          }
        } else {
          if(argValue != null) {
            if(i > 0) {
              url.append("&")
            }
            var stringValue = getStringValue(argValue)
            url.append(URLEncoder.encode(param.Name, "UTF-8")).append("=").append(URLEncoder.encode(stringValue.toString(), "UTF-8"))
          }
        }
      }
    }
    return url.toString()
  }

  @Deprecated("Block-based methods have been deprecated.  Use urlFor(Foo#bar()) instead.")
  static function urlFor(target : Object) : String {
    var args = (target as URLBlock).Args
    if(args[0] == null) {
      throw "Attempted to generate a URL from a non-existent method."
    }
    var mi = args[0] as IMethodInfo
    var actionName = mi.DisplayName
    var methodOwner = mi.OwnersType
    var parameters = mi.Parameters
    if( Type.isAssignableFrom( methodOwner ) )
    {
      methodOwner = (methodOwner as IMetaType).Type
    }
    if(!RoninController.Type.isAssignableFrom(methodOwner)) {
      throw "Attempted to generate a URL from a method on a non-controller class"
    }
    var controllerName = methodOwner.RelativeName
    var prefix = Ronin.CurrentRequest.Prefix
    var url : StringBuilder
    if(prefix != null) {
      url = new StringBuilder(prefix)
    } else {
      url = new StringBuilder()
    }
    url.append(controllerName).append("/").append(actionName)
    if(args.Count > 1) {
      url.append("?")
      for (i in 0..|args.Count - 1) {
        var argValue = args[i + 1]
        if(parameters[i].FeatureType.Array) {
          var arrayType = parameters[i].FeatureType
          if(argValue != null) {
            var arrayLength = arrayType.getArrayLength(argValue)
            for(j in 0..|arrayLength) {
              var componentValue = arrayType.getArrayComponent(argValue, j)
              if(componentValue != null) {
                if(i > 0 or j > 0) {
                  url.append("&")
                }
                var stringValue = getStringValue(componentValue)
                url.append(URLEncoder.encode(parameters[i].getName(), "UTF-8")).append("[").append(j).append("]").append("=").append(URLEncoder.encode(stringValue.toString(), "UTF-8"))
              }
            }
          }
        } else {
          if(argValue != null) {
            if(i > 0) {
              url.append("&")
            }
            var stringValue = getStringValue(argValue)
            url.append(URLEncoder.encode(parameters[i].getName(), "UTF-8")).append("=").append(URLEncoder.encode(stringValue.toString(), "UTF-8"))
          }
        }
      }
    }
    return url.toString()
  }
  
  private static function getStringValue(argValue : Object) : String {
    var stringValue : String
    var idMethod = (typeof argValue).TypeInfo.getMethod("toID", {})
    if(idMethod != null) {
        return idMethod.CallHandler.handleCall(argValue, {}) as String
    } else {
        return argValue as String
    }
  }

  static function baseUrlFor(target : MethodReference) : String {
    return "${Ronin.CurrentRequest.Prefix?:""}${target.MethodInfo.OwnersType.RelativeName}/${target.MethodInfo.DisplayName}"
  }

  @Deprecated("Block-based methods have been deprecated.  Use baseUrlFor(Foo#bar()) instead.")
  static function baseUrlFor(target : IMethodInfo) : String {
    var actionName = target.DisplayName
    var methodOwner = target.OwnersType
    if(methodOwner typeis IMetaType) {
      methodOwner = methodOwner.Type
    }
    if(!RoninController.Type.isAssignableFrom(methodOwner)) {
      throw "Attempted to generate a URL from a method on a non-controller class"
    }
    var controllerName = methodOwner.RelativeName
    var prefix = Ronin.CurrentRequest.Prefix
    var url : StringBuilder
    if(prefix != null) {
      url = new StringBuilder(prefix)
    } else {
      url = new StringBuilder()
    }
    url.append(controllerName).append("/").append(actionName)
    return url.toString()
  }

  static function makeURLBlock(args : List<Object>) : URLBlock {
    return new URLBlock() {:Args = args}
  }

  static class URLBlock implements IFunction0 {
    var _args : List<Object> as Args
  }

}