package ronin

uses java.net.*
uses java.util.*
uses java.util.concurrent.*
uses java.util.concurrent.locks.*
uses java.lang.*
uses java.io.*

uses javax.servlet.FilterChain
uses javax.servlet.http.HttpServlet
uses javax.servlet.http.HttpServletRequest
uses javax.servlet.http.HttpServletResponse
uses javax.servlet.http.HttpSession

uses org.stringtree.json.*
uses org.apache.commons.fileupload.*

uses gw.config.CommonServices

uses gw.lang.reflect.TypeSystem
uses gw.lang.reflect.IMethodInfo

uses gw.lang.parser.exceptions.IncompatibleTypeException
uses gw.lang.parser.exceptions.IEvaluationException
uses gw.lang.parser.exceptions.ErrantGosuClassException
uses gw.lang.parser.exceptions.ParseResultsException
uses gw.lang.parser.template.TemplateParseException
uses gw.util.Pair
uses gw.util.GosuExceptionUtil

uses ronin.config.*

/**
 * The servlet responsible for handling Ronin requests.
 */
class RoninServlet extends HttpServlet {

  construct(dev : boolean) {
    Ronin.init(this, dev)  
  }

  override function doGet(req : HttpServletRequest, resp : HttpServletResponse) {
    handleRequest(req, resp, GET)
  }

  override function doPost(req : HttpServletRequest, resp : HttpServletResponse) {
    handleRequest(req, resp, POST)
  }

  override function doPut(req : HttpServletRequest, resp : HttpServletResponse) {
    handleRequest(req, resp, PUT)
  }

  override function doDelete(req : HttpServletRequest, resp : HttpServletResponse) {
    handleRequest(req, resp, DELETE)
  }

  function handleRequest(req : HttpServletRequest, resp : HttpServletResponse, httpMethod : HttpMethod) {

    if(Ronin.Mode == DEVELOPMENT) {
      TypeSystem.refresh()
    }

    if(Ronin.Config.Filters.HasElements) {
      var filterIndex = 0
      var filterChain : FilterChain
      filterChain = \ fReq, fResp -> {
        filterIndex++
        if(filterIndex == Ronin.Config.Filters.Count) {
          doHandleRequest(fReq as HttpServletRequest, fResp as HttpServletResponse, httpMethod)
        } else {
          Ronin.Config.Filters[filterIndex].doFilter(fReq, fResp, filterChain)
        }
      }
      Ronin.Config.Filters[0].doFilter(req, resp, filterChain)
    } else {
      doHandleRequest(req, resp, httpMethod)
    }
  }

  private function doHandleRequest(req : HttpServletRequest, resp : HttpServletResponse, httpMethod : HttpMethod) {
    resp.ContentType = "text/html"
    var prefix = "${req.Scheme}://${req.ServerName}${req.ServerPort == 80 ? "" : (":" + req.ServerPort)}${req.ContextPath}${req.ServletPath}/"
    var out = resp.Writer
    var path = req.PathInfo

    using(new RoninRequest(prefix, resp, req, httpMethod, new SessionMap(req.Session), req.getHeader("referer"))) {
      if(Ronin.Config.XSRFLevel.contains(httpMethod)) {
        Ronin.CurrentRequest.checkXSRF()
      }
      using(Ronin.CurrentTrace?.withMessage("request for ${path}")) {
        if(path != null) {
          try {
            var pathSplit = path.split("/")
            var startIndex = path.startsWith("/") ? 1 : 0
            var controllerType = getControllerType(pathSplit, startIndex)
            var action = getActionName(pathSplit, startIndex)
            var actionMethod : IMethodInfo = null
            var params = new Object[0]
            var reqParams = new ParameterAccess(req)
            var files : List<FileItem> = {}
            var jsonpCallback : String = null
            if(Ronin.Config.ServletFileUpload.isMultipartContent(req)) {
              files = Ronin.Config.ServletFileUpload.parseRequest(req) as List<FileItem>
            }
            for(method in controllerType.TypeInfo.Methods) {
              if(method.Public and method.DisplayName == action) {
                // TODO error if there's more than one
                checkMethodPermitted(method, httpMethod)
                jsonpCallback = getJsonpCallback(method, reqParams)
                var parameters = method.Parameters
                params = new Object[parameters.Count]
                for (i in 0..|parameters.Count) {
                  var parameterInfo = parameters[i]
                  var paramName = parameterInfo.Name
                  var paramType = parameterInfo.FeatureType
                  if(paramType.isAssignableFrom(byte[]) or paramType.isAssignableFrom(InputStream)) {
                    var file = files.firstWhere(\f -> f.FieldName == paramName)
                    if(file != null) {
                      if(paramType.isAssignableFrom(byte[])) {
                        params[i] = file.get()
                      } else {
                        params[i] = file.InputStream
                      }
                    }
                  } else if(paramType.Array) {
                    var maxIndex = -1
                    var paramValues = new HashMap<Integer, Object>()
                    var propertyValueParams = new HashSet<String>()
                    var componentType = paramType.ComponentType
                    maxIndex = Math.max(maxIndex, processArrayParam(reqParams, paramName, paramType, paramValues, maxIndex))
                    maxIndex = Math.max(maxIndex, processArrayParamProperties(reqParams, paramName, paramType, paramValues, maxIndex))
                    if(maxIndex > -1) {
                      var array = componentType.makeArrayInstance(maxIndex + 1)
                      for(j in 0..maxIndex) {
                        var paramValue = paramValues[j]
                        if(paramValue != null) {
                          paramType.setArrayComponent(array, j, paramValue)
                          params[i] = array
                        }
                      }
                    }
                  } else {
                    var paramValue = processNonArrayParam(reqParams, paramName, paramType)
                    if(paramValue != null) {
                      params[i] = paramValue
                    }
                    processNonArrayParamProperties(reqParams, paramName, paramType, params, i)
                  }
                }
                actionMethod = method
                break
              }
            }
            if(actionMethod == null) {
              throw new FourOhFourException("Action ${action} not found.")
            }

            var paramsMap = new HashMap<String, Object>()
            params.eachWithIndex(\p, i -> {
              paramsMap[actionMethod.Parameters[i].Name] = p
            })

            if(jsonpCallback != null) {
              resp.Writer.write("${jsonpCallback}(")
            }
            executeControllerMethod(controllerType, actionMethod, params, paramsMap)
            if(jsonpCallback != null) {
              resp.Writer.write(")")
            }

          } catch (e : FourOhFourException) {
            handle404(e, req, resp)
          } catch (e : FiveHundredException) {
            handle500(e, req, resp)
          }
        }
      }
      if(Ronin.TraceEnabled) {
        for(str in Ronin.CurrentTrace.toString().split("\n")) {
          Ronin.log(str, INFO, "Ronin", null)
        }
      }
    }
  }

  private function getControllerType(pathSplit : String[], startIndex : int) : Type {
    var controllerType : Type
    if(pathSplit.length < startIndex + 1) {
      if(Ronin.DefaultController == null) {
        throw new MalformedURLException()
      } else {
        controllerType = Ronin.DefaultController
      }
    } else {
      var controller = pathSplit[startIndex]
      controllerType = TypeSystem.getByFullNameIfValid("controller.${controller}")
      if(controllerType == null) {
        throw new FourOhFourException("Controller ${controller} not found.")
      } else if(not RoninController.Type.isAssignableFrom(controllerType)) {
        throw new FourOhFourException("Controller ${controller} is not a valid controller.")              
      }
    }
    return controllerType
  }
  
  private function getActionName(pathSplit : String[], startIndex : int) : String {
    if(pathSplit.length < startIndex + 2) {
      return Ronin.DefaultAction
    } else {
      return pathSplit[startIndex + 1]
    }
  }
  
  private function processNonArrayParam(reqParams : ParameterAccess, paramName : String, paramType : Type) : Object {
    var paramValue = reqParams.getParameterValue(paramName)
    if(paramValue != null or boolean == paramType) {
      try {
        return convertValue(paramType, paramValue)
      } catch (e : IncompatibleTypeException) {
        var factoryMethod = getFactoryMethod(paramType)
        if(factoryMethod != null) {
            try {
              return factoryMethod.CallHandler.handleCall(null, {convertValue(factoryMethod.Parameters[0].FeatureType, paramValue)})
            } catch (e2 : java.lang.Exception) {
                throw new FiveHundredException("Could not retrieve instance of ${paramType} using ${factoryMethod} with argument ${paramValue}", e2)
            }
        } else {
          throw new FiveHundredException("Could not coerce value ${paramValue} of parameter ${paramName} to type ${paramType.Name}", e)
        }
      }
    } else {
      if(paramType.Primitive) {
        throw new FiveHundredException("Missing required (primitive) parameter ${paramName}.")
      }
    }
    return null
  }
  
  private function processNonArrayParamProperties(reqParams : ParameterAccess, paramName : String, paramType : Type, params : Object[], i : int) {
    for(prop in reqParams.getParameterProperties(paramName)) {
      var propertyName = prop.First
      var paramValue = prop.Second
      var propertyInfo = paramType.TypeInfo.getProperty(propertyName)
      if(propertyInfo != null) {
        var propertyType = propertyInfo.FeatureType
        var propertyValue : Object
        try {
          propertyValue = convertValue(propertyType, paramValue)
        } catch (e : IncompatibleTypeException) {
          throw new FiveHundredException("Could not coerce value ${paramValue} of parameter ${paramName} to type ${propertyType.Name}", e)
        }
        if(params[i] == null) {
          var constructor = paramType.TypeInfo.getConstructor({})
          if(constructor != null) {
            params[i] = constructor.Constructor.newInstance({})
          } else {
            throw new FiveHundredException("Could not construct object of type ${paramType} implied by property parameters, because no no-arg constructor is defined.")
          }
        }
        propertyInfo.Accessor.setValue(params[i], propertyValue)
      } else {
        throw new FiveHundredException("Could not find property ${propertyName} on type ${paramType.Name}")
      }
    }
  }
  
  private function processArrayParam(reqParams : ParameterAccess, paramName : String, paramType : Type, paramValues : Map<Integer, Object>, maxIndex : int) : int {
    var componentType = paramType.ComponentType
    for(prop in reqParams.getArrayParameterValues(paramName)) {
      var index = prop.First
      maxIndex = Math.max(maxIndex, index)
      var paramValue = prop.Second
      try {
        paramValues.put(index, convertValue(componentType, paramValue))
      } catch (e : IncompatibleTypeException) {
        throw new FiveHundredException("Could not coerce value ${paramValue} of parameter ${paramName} to type ${componentType.Name}", e)
      }
    }
    return maxIndex
  }
  
  private function processArrayParamProperties(reqParams : ParameterAccess, paramName : String, paramType : Type, paramValues : Map<Integer, Object>, maxIndex : int) : int {
    var componentType = paramType.ComponentType
    for (prop in reqParams.getArrayPropertyParameterValues(paramName)) {
      var index = prop.First
      var propertyName = prop.Second.First
      var propertyParamValue = prop.Second.Second
      maxIndex = Math.max(maxIndex, index)
      var paramValue = paramValues[index]
      if(paramValue == null) {
        var constructor = componentType.TypeInfo.getConstructor({})
        if(constructor != null) {
          paramValue = constructor.Constructor.newInstance({})
        } else {
          throw new FiveHundredException("Could not construct object of type ${paramType} implied by property parameters, because no no-arg constructor is defined.")
        }
        paramValues[index] = paramValue
      }
      var propertyInfo = componentType.TypeInfo.getProperty(propertyName)
      if(propertyInfo != null) {
        var propertyType = propertyInfo.FeatureType
        var propertyValue : Object
        try {
          propertyValue = convertValue(propertyType, propertyParamValue)
        } catch (e : IncompatibleTypeException) {
          throw new FiveHundredException("Could not coerce value ${propertyParamValue} of parameter ${paramName}[${index}].${propertyName} to type ${propertyType.Name}", e)
        }
        propertyInfo.Accessor.setValue(paramValue, propertyValue)
      } else {
        throw new FiveHundredException("Could not find property ${propertyName} on type ${componentType.Name}")
      }
    }
    return maxIndex
  }
  
  private function executeControllerMethod(controllerType : Type, actionMethod : IMethodInfo, params : Object[], paramsMap : HashMap<String, Object>) {
    var ctor = controllerType.TypeInfo.getConstructor({})
    if(ctor == null) {
      throw new FiveHundredException("No default (no-argument) constructor found on ${controllerType}")
    }

    try {
      var instance = ctor.Constructor.newInstance({}) as RoninController
      var beforeRequest = true
      using(Ronin.CurrentTrace?.withMessage(actionMethod.OwnersType.Name + ".beforeRequest()")) {
        beforeRequest = instance.beforeRequest(paramsMap)
      }
      if(beforeRequest) {
        using(Ronin.CurrentTrace?.withMessage(actionMethod.OwnersType.Name + "." + actionMethod.DisplayName)) {
          actionMethod.CallHandler.handleCall(instance, params)
        }
        using(Ronin.CurrentTrace?.withMessage(actionMethod.OwnersType.Name + ".afterRequest()")) {
          instance.afterRequest(paramsMap)
        }
      }
    } catch (e : Exception) {
      //TODO cgross - the logger jacks the errant gosu class message up horribly.
      //TODO cgross - is there a way around that?
      var cause = GosuExceptionUtil.findExceptionCause(e)
      if(e typeis ErrantGosuClassException) {
        print("Invalid Gosu class was found : \n\n" + e.GsClass.ParseResultsException.Feedback + "\n\n")
        throw new FiveHundredException("ERROR - Evaluation of method ${actionMethod.Name} on controller ${controllerType.Name} failed because " + e.GsClass.Name + " is invalid.")
      } else if(cause typeis TemplateParseException) {
        print("Invalid Gosu template was found : \n\n" + cause.Message + "\n\n")
        throw new FiveHundredException("ERROR - Evaluation of method ${actionMethod.Name} on controller ${controllerType.Name} failed.")
      } else if(cause typeis ParseResultsException) {
        print("Gosu parse exception : \n\n" + cause.Feedback + "\n\n")
        throw new FiveHundredException("ERROR - Evaluation of method ${actionMethod.Name} on controller ${controllerType.Name} failed.")
      } else {
        log("Evaluation of method ${actionMethod.Name} on controller ${controllerType.Name} failed.")
        throw new FiveHundredException("ERROR - Evaluation of method ${actionMethod.Name} on controller ${controllerType.Name} failed.", e)
      }
    }
  }

  private function checkMethodPermitted(method : IMethodInfo, httpMethod : HttpMethod) {
    var methodsAnnotation = method.getAnnotation(Methods)?.Instance as Methods
    if(methodsAnnotation != null and not methodsAnnotation.PermittedMethods?.contains(httpMethod)) {
      throw new FiveHundredException("${httpMethod} not permitted on ${method}.")
    }
  }

  private function getJsonpCallback(method : IMethodInfo, params : ParameterAccess) : String {
    var jsonpAnnotation = method.getAnnotation(JSONP)?.Instance as JSONP
    if(jsonpAnnotation != null) {
      return params.getParameterValue(jsonpAnnotation.Callback)
    } else {
      return null
    }
  }

  private function handle404(e : FourOhFourException, req : HttpServletRequest, resp : HttpServletResponse) {
    Ronin.ErrorHandler.on404(e, req, resp)
  }
  
  private function handle500(e : FiveHundredException, req : HttpServletRequest, resp : HttpServletResponse) {
    Ronin.ErrorHandler.on500(e, req, resp)
  }

  private function convertValue(paramType : Type, paramValue : String) : Object {
    if (paramType == boolean) {
      return "on".equals(paramValue) or "true".equals(paramValue)
    }
    if(not paramValue?.HasContent) {
      if(not paramType.Primitive) {
        return null
      } else {
        throw new IncompatibleTypeException()
      }
    }
    var factoryMethod = getFactoryMethod(paramType)
    if(factoryMethod != null) {
      return factoryMethod.CallHandler.handleCall(null, {convertValue(factoryMethod.Parameters[0].FeatureType, paramValue)})
    } else {
      switch(paramType) {
      case int:
      case Integer:
        return Integer.parseInt(paramValue)
      case long:
      case Long:
        return Long.parseLong(paramValue)
      case float:
      case Float:
        return Float.parseFloat(paramValue)
      case double:
      case Double:
        return Double.parseDouble(paramValue)
      case java.util.Date:
        return new java.util.Date(paramValue)
      default:
        return CommonServices.getCoercionManager().convertValue(paramValue, paramType)
      }
    }
  }
  
  private function getFactoryMethod(type : Type) : IMethodInfo {
    for(var method in type.TypeInfo.Methods) {
      if(method.Static and method.DisplayName == "fromID" and method.ReturnType.Name == type.Name and method.Parameters.Count == 1) {
        return method
      }
    }
    return null
  }

  private class ParameterAccess {

    var _req : HttpServletRequest
    var _json : boolean
    var _jsonObj : Map<Object, Object>

    construct(req : HttpServletRequest) {
      _req = req
      if(_req.ContentType?.split(";")?[0] == "text/json") {
        _json = true
        var body = new StringBuilder()
        var reader = _req.Reader
        var line = reader.readLine()
        while(line != null) {
          body.append(line).append("\n")
          line = reader.readLine()
        }
        var obj = new JSONValidatingReader().read(body.toString())
        if(obj typeis Map<Object, Object>) {
          _jsonObj = obj
        } else {
          throw new FiveHundredException("JSON did not parse as an object: ${obj}")
        }
      } else {
        _json = false
      }
    }

    function getParameterValue(name : String) : String {
      if(_json) {
        var value = _jsonObj[name]
        if(value typeis Map<Object, Object>) {
          return value["fromID"] as String
        } else {
          return value as String
        }
      } else {
        return decode(_req.getParameter(name))
      }
    }

    function getParameterProperties(name : String) : List<Pair<String, String>> {
      var rtn = new ArrayList<Pair<String, String>>()
      if(_json) {
        var value = _jsonObj[name]
        if(value typeis Map<Object, Object>) {
          value.eachKeyAndValue(\k, v -> {
            if(k != "fromID") {
              rtn.add(Pair.make(k as String, v as String))
            }
          })
        }
      } else {
        var parameterNames = _req.getParameterNames()
        while(parameterNames.hasMoreElements()) {
          var reqParamName = parameterNames.nextElement().toString()
          if(reqParamName.startsWith(name + ".")) {
            var propertyName = reqParamName.substring((name + ".").length)
            rtn.add(Pair.make(propertyName, decode(_req.getParameter(reqParamName))))
          }
        }
      }
      return rtn
    }

    function getArrayParameterValues(name : String) : List<Pair<Integer, String>> {
      var rtn = new ArrayList<Pair<Integer, String>>()
      if(_json) {
        var value = _jsonObj[name]
        if(value typeis List<Object>) {
          value.eachWithIndex(\v, i -> {
            if(v typeis Map<Object, Object>) {
              rtn.add(Pair.make(i, v["fromID"] as String))
            } else {
              rtn.add(Pair.make(i, v as String))
            }
          })
        } else if(value != null) {
          throw new FiveHundredException("Expected an array value for parameter ${name}; got a ${typeof value}, ${value}")
        }
      } else {
        var parameterNames = _req.ParameterNames
        while(parameterNames.hasMoreElements()) {
          var reqParamName = parameterNames.nextElement().toString()
          if(reqParamName.startsWith(name) and reqParamName[name.length] == "[") {
            if(reqParamName.lastIndexOf("]") == reqParamName.length - 1) {
              var index : int
              try {
                index = Integer.decode(reqParamName.substring(name.length + 1, reqParamName.length - 1))
              } catch (e : NumberFormatException) {
                throw new FiveHundredException("Malformed indexed parameter ${reqParamName}", e)
              }
              rtn.add(Pair.make(index, decode(_req.getParameter(reqParamName))))
            }
          }
        }
      }
      return rtn
    }

    function getArrayPropertyParameterValues(name : String) : List<Pair<Integer, Pair<String, String>>> {
      var rtn = new ArrayList<Pair<Integer, Pair<String, String>>>()
      if(_json) {
        var value = _jsonObj[name]
        if(value typeis List<Object>) {
          value.eachWithIndex(\v, i -> {
            if(v typeis Map<Object, Object>) {
              v.eachKeyAndValue(\key, val -> {
                if(key != "fromID") {
                  rtn.add(Pair.make(i, Pair.make(key as String, val as String)))
                }
              })
            }
          })
        }
      } else {
        var parameterNames = _req.ParameterNames
        while(parameterNames.hasMoreElements()) {
          var reqParamName = parameterNames.nextElement().toString()
          if(reqParamName.startsWith(name) and reqParamName[name.length] == "[") {
            var index : int
            try {
              index = Integer.decode(reqParamName.substring(name.length + 1, reqParamName.lastIndexOf("]")))
            } catch (e : NumberFormatException) {
              throw new FiveHundredException("Malformed indexed parameter ${reqParamName}", e)
            }
            if(reqParamName.lastIndexOf("]") != reqParamName.length - 1 and reqParamName[reqParamName.lastIndexOf("]") + 1] == ".") {
              var propertyName = reqParamName.substring(reqParamName.lastIndexOf("]") + 2)
              var propertyValue = decode(_req.getParameter(reqParamName))
              rtn.add(Pair.make(index, Pair.make(propertyName, propertyValue)))
            }
          }
        }
      }
      return rtn
    }
  }

  private function decode(str : String) : String {
    return str == null ? null : URLDecoder.decode(str, "UTF-8")
  }

}