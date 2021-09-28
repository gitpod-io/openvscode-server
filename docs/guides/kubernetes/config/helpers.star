load("@ytt:data", "data")

def labels_for_component(comp):
  return {
    "app.kubernetes.io/name": comp,
    "app.kubernetes.io/part-of": data.values.APP,
  }
end
